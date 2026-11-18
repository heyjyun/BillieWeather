// Personalized messages for the signed-in account, in the interface language.
// `say(message)` fills a named/plain message with the nickname when the account has one.
import { useCallback, useMemo } from "react";
import { useAccount } from "./useAccount";
import { useI18n } from "../i18n";
import { personalize, type NamedMessage } from "../services/greeting";
import { preferredName } from "../services/profile";

export function usePersonal() {
  const { m } = useI18n();
  const { account } = useAccount();
  const name = useMemo(() => preferredName(account), [account]);
  const say = useCallback((message: NamedMessage, vars?: Record<string, string | number>) => personalize(message, name, vars), [name]);
  return { p: m.personal, name, say };
}
