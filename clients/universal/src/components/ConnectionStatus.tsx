// Shown while signed in from the saved session but the BillieWeather server can't be reached.
// Everything local keeps working; only account refresh and cloud features wait for the server.
import { useAccount } from "../hooks/useAccount";
import { useI18n } from "../i18n";

export function ConnectionStatus() {
  const { offlineReason, reconnecting, reconnect } = useAccount();
  const { m } = useI18n();
  if (!offlineReason) return null;
  const c = m.connection;
  return (
    <p className="bw-message bw-message-warn bw-connection-status" role="status">
      {offlineReason === "offline" ? c.offline : c.unreachable}{" "}
      <button type="button" className="bw-link-button" disabled={reconnecting} onClick={() => void reconnect()}>
        {reconnecting ? c.checking : c.retry}
      </button>
    </p>
  );
}
