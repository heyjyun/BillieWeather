import { useId, useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { connectSearchableSelect, type SearchableSelectOption } from "../../../../public/searchable-select.mjs";
import "../../../../public/searchable-select.css";
import { useI18n } from "../i18n";

type SearchKind = "currency" | "region";

type Props = Omit<ComponentPropsWithoutRef<"select">, "children" | "defaultValue" | "multiple" | "size" | "value" | "onChange"> & {
  options: readonly SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  kind: SearchKind;
};

const currencySearch = {
  en: { label: "Search currencies", noMatch: "No currency matches that search." },
  "zh-CN": { label: "搜索币种", noMatch: "没有找到匹配的币种。" },
  "zh-TW": { label: "搜尋幣別", noMatch: "找不到符合的幣別。" },
  ja: { label: "通貨を検索", noMatch: "一致する通貨がありません。" },
  ko: { label: "통화 검색", noMatch: "검색과 일치하는 통화가 없습니다." },
  es: { label: "Buscar monedas", noMatch: "Ninguna moneda coincide con la búsqueda." },
};

export function currencyOptions(codes: readonly string[], blank?: string): SearchableSelectOption[] {
  const options = codes.map((code) => ({ value: code, label: code }));
  return blank === undefined ? options : [{ value: "", label: blank }, ...options];
}

export function SearchableSelect({ options, value, onChange, kind, ...selectProps }: Props) {
  const { m, locale } = useI18n();
  const search = kind === "region" ? { label: m.register.regionSearch, noMatch: m.register.regionNoMatch } : currencySearch[locale];
  const searchId = useId();
  const listId = `${searchId}-matches`;
  const root = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof connectSearchableSelect> | null>(null);

  useLayoutEffect(() => {
    const picker = connectSearchableSelect(root.current!);
    controller.current = picker;
    return () => {
      picker.disconnect();
      controller.current = null;
    };
  }, [kind]);

  useLayoutEffect(() => {
    controller.current?.update(options, value);
  }, [kind, options, value]);

  return (
    <div ref={root} className="bw-searchable-select" data-searchable-select={kind}>
      <input id={searchId} type="search" role="combobox" aria-label={search.label} aria-controls={listId} aria-expanded="false" aria-autocomplete="list"
        placeholder={m.register.regionSearchPlaceholder} autoComplete="off" spellCheck={false} disabled={selectProps.disabled} />
      <select {...selectProps} onChange={(event) => onChange(event.target.value)} />
      <ul id={listId} role="listbox" aria-labelledby={searchId} hidden />
      <small role="status" hidden>{search.noMatch}</small>
    </div>
  );
}
