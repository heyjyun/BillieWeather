// "Send to BillieWeather web" for one captured receipt: the only code that sends a receipt off the
// device, and only when the person presses the button on the receipt screen (never automatic,
// never in the background, never retried by itself). It goes to the person's own BillieWeather
// server, signed in with the app's session. Sent: the recognized text lines with their
// confidences, the reviewed fields, the OCR engine's id and, when it is at most 8 MB, the original
// image or PDF. `client_request_id` is fixed for one capture, so pressing Send again (a retry
// after a timeout) can never create a second receipt on the website. test/privacy.test.ts pins it.
import { API_ORIGIN, AccountError } from "./account";

const ENDPOINT = `${API_ORIGIN}/api/client/v1/finance/receipts`;
/** The original file travels only up to this size; larger captures send text and fields only. */
export const MAX_RECEIPT_UPLOAD_BYTES = 8 * 1024 * 1024;

export interface ReceiptSendInput {
  clientRequestId: string;
  engine: string;
  lines: ReadonlyArray<{ text: string; confidence: number | null }>;
  fields: {
    merchant: string | null; date: string | null; time: string | null; total: string | null; currency: string | null;
    tax: string | null; tip: string | null; payment_method: string | null; card_last4: string | null; receipt_number: string | null;
    direction: "purchase" | "refund";
  };
  file: { bytes: Uint8Array; filename: string; contentType: string } | null;
}

export type WebReceiptStatus = "needs_review" | "pending_bank_match" | "cash" | "matched" | "possible_duplicate" | "duplicate" | string;

export interface WebReceiptResult {
  created: boolean;
  receipt: {
    id: number | string;
    status: WebReceiptStatus;
    verification: string | null;
    issues: string[];
    match: { level: string; transaction: { id: number | string; booked_on: string; description: string; amount: string } | null } | null;
    duplicateOf: number | string | null;
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** Sends one receipt. The caller passes the same `clientRequestId` for every attempt of one capture. */
export async function sendReceipt(token: string, input: ReceiptSendInput): Promise<WebReceiptResult> {
  const file = input.file && input.file.bytes.byteLength <= MAX_RECEIPT_UPLOAD_BYTES ? input.file : null;
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receipt: {
          client_request_id: input.clientRequestId,
          source: "app",
          engine: input.engine,
          lines: input.lines.map((line) => ({ text: line.text, confidence: line.confidence })),
          fields: input.fields,
          ...(file ? { file_base64: base64(file.bytes), filename: file.filename, content_type: file.contentType } : {}),
        },
      }),
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new AccountError("offline");
  }
  const json = (await response.json().catch(() => ({}))) as { created?: unknown; receipt?: Record<string, unknown>; error?: string };
  if (response.status === 401) throw new AccountError("unauthorized");
  if (response.status === 429) throw new AccountError("rate_limited");
  if (response.status === 413) throw new AccountError("invalid", "too_large");
  if (response.status === 422) throw new AccountError("invalid", typeof json.error === "string" ? json.error : "invalid");
  if (!response.ok || !json.receipt || typeof json.receipt !== "object") throw new AccountError("unknown");
  const receipt = json.receipt;
  const match = receipt.match && typeof receipt.match === "object" ? (receipt.match as Record<string, unknown>) : null;
  const transaction = match?.transaction && typeof match.transaction === "object" ? (match.transaction as Record<string, unknown>) : null;
  return {
    created: json.created === true,
    receipt: {
      id: receipt.id as number | string,
      status: typeof receipt.status === "string" ? receipt.status : "needs_review",
      verification: typeof receipt.verification === "string" ? receipt.verification : null,
      issues: Array.isArray(receipt.issues) ? receipt.issues.filter((issue): issue is string => typeof issue === "string") : [],
      match: match ? {
        level: String(match.level ?? "none"),
        transaction: transaction ? { id: transaction.id as number | string, booked_on: String(transaction.booked_on ?? ""), description: String(transaction.description ?? ""), amount: String(transaction.amount ?? "") } : null,
      } : null,
      duplicateOf: (receipt.duplicate_of as number | string | null | undefined) ?? null,
    },
  };
}
