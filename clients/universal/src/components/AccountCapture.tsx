import { useEffect, useRef } from "react";
import { decimalToCents, isAccountType, isLiability } from "@billie/finance-core";
import { mountCapture } from "../../../../public/account-assistant.mjs";
import copy from "../../../../packages/shared-types/schema/assistant-copy.json";
import { useFinance } from "../hooks/useFinance";
import { useAccount } from "../hooks/useAccount";
import { useI18n } from "../i18n";
import { randomId } from "../services/ids";
import { LedgerError } from "../services/ledger";

export function AccountCapture({ currency, manual, statement, suggestion }: { suggestion?: string; currency: string; manual(): void; statement(): void }) {
  const { m, locale } = useI18n();
  const { account } = useAccount();
  const { store, accounts, refresh } = useFinance();
  const root = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ manual, statement, refresh });
  callbacks.current = { manual, statement, refresh };
  const region = account?.usageRegion || "";
  useEffect(() => {
    if (!root.current) return;
    return mountCapture(root.current, {
      copy: copy[locale], types: m.ledger.accountTypes, add: copy[locale].ai, empty: !accounts.some(a => !a.archived && !a.unassigned),
      currency, region, accounts, suggestion, id: randomId, manual: () => callbacks.current.manual(), statement: () => callbacks.current.statement(),
      recognize: async file => {
        const { recognizeReceipt } = await import("../services/receipt");
        const result = await recognizeReceipt(new Uint8Array(await file.arrayBuffer()), file.name);
        return result.lines.filter(line => line.confidence == null || line.confidence >= 0.65).map(line => line.text).join("\n");
      },
      commit: async batch => {
        if (!batch.confirmed) throw new Error("confirmation");
        const inputs = batch.rows.map(row => {
          if (!isAccountType(row.type) || row.currency !== currency) throw new Error("invalid");
          const cents = row.amount ? decimalToCents(row.amount) : null;
          return { name: row.name, institution: row.institution || null, last4: row.last4 || null, type: row.type, currency,
            openingBalanceOn: row.date || null, openingBalanceCents: cents !== null && isLiability(row.type) ? -cents : cents };
        });
        try { await store.ledger.createAccounts(inputs, "user", {key:batch.key,source:batch.source,origins:batch.rows.map(r => r.origins || {})}); }
        catch (error) { if (error instanceof LedgerError && error.code === "name_taken") throw new Error("duplicate"); throw error; }
        await callbacks.current.refresh();
      },
    });
  }, [store, accounts, currency, region, locale, m, suggestion]);
  return <div ref={root} />;
}
