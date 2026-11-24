import type { Locale } from "./index";

const en = {
  ledger: "Ledger", deviceLedger: "This device", account: "Account", allAccounts: "All accounts",
  startDate: "Start date", endDate: "End date", applyDates: "Apply dates", invalidDates: "Choose a valid start and end date.",
  noMatches: "No transactions match these filters.", reset: "Reset filters", switching: "Opening ledger…",
  ledgerError: "Couldn't open the selected ledger.", monthly: "Monthly cash flow", spendingByCategory: "Spending by category",
  incomeByCategory: "Income by category", noIncome: "No income in this period.", viewAll: "View all transactions",
};

export const overviewCopy: Record<Locale, typeof en> = {
  en,
  "zh-CN": {
    ledger: "账本", deviceLedger: "此设备", account: "账户", allAccounts: "所有账户",
    startDate: "开始日期", endDate: "结束日期", applyDates: "应用日期", invalidDates: "请选择有效的开始和结束日期。",
    noMatches: "没有符合这些筛选条件的交易。", reset: "重置筛选", switching: "正在打开账本…",
    ledgerError: "无法打开所选账本。", monthly: "每月现金流", spendingByCategory: "按类别划分的支出",
    incomeByCategory: "按类别划分的收入", noIncome: "这一期间没有收入。", viewAll: "查看全部交易",
  },
  "zh-TW": {
    ledger: "帳本", deviceLedger: "此裝置", account: "帳戶", allAccounts: "所有帳戶",
    startDate: "開始日期", endDate: "結束日期", applyDates: "套用日期", invalidDates: "請選擇有效的開始和結束日期。",
    noMatches: "沒有符合這些篩選條件的交易。", reset: "重設篩選", switching: "正在開啟帳本…",
    ledgerError: "無法開啟選取的帳本。", monthly: "每月現金流", spendingByCategory: "依類別劃分的支出",
    incomeByCategory: "依類別劃分的收入", noIncome: "這一期間沒有收入。", viewAll: "查看所有交易",
  },
  ja: {
    ledger: "帳簿", deviceLedger: "この端末", account: "口座", allAccounts: "すべての口座",
    startDate: "開始日", endDate: "終了日", applyDates: "日付を適用", invalidDates: "有効な開始日と終了日を選択してください。",
    noMatches: "条件に一致する取引がありません。", reset: "条件をリセット", switching: "帳簿を開いています…",
    ledgerError: "選択した帳簿を開けませんでした。", monthly: "月ごとのキャッシュフロー", spendingByCategory: "カテゴリ別支出",
    incomeByCategory: "カテゴリ別収入", noIncome: "この期間に収入はありません。", viewAll: "すべての取引を表示",
  },
  ko: {
    ledger: "장부", deviceLedger: "이 기기", account: "계좌", allAccounts: "모든 계좌",
    startDate: "시작일", endDate: "종료일", applyDates: "날짜 적용", invalidDates: "유효한 시작일과 종료일을 선택하세요.",
    noMatches: "이 필터에 맞는 거래가 없습니다.", reset: "필터 초기화", switching: "장부를 여는 중…",
    ledgerError: "선택한 장부를 열 수 없습니다.", monthly: "월별 현금 흐름", spendingByCategory: "카테고리별 지출",
    incomeByCategory: "카테고리별 수입", noIncome: "이 기간에 수입이 없습니다.", viewAll: "모든 거래 보기",
  },
  es: {
    ledger: "Libro", deviceLedger: "Este dispositivo", account: "Cuenta", allAccounts: "Todas las cuentas",
    startDate: "Fecha inicial", endDate: "Fecha final", applyDates: "Aplicar fechas", invalidDates: "Elige fechas de inicio y fin válidas.",
    noMatches: "Ningún movimiento coincide con estos filtros.", reset: "Restablecer filtros", switching: "Abriendo el libro…",
    ledgerError: "No se pudo abrir el libro seleccionado.", monthly: "Flujo de efectivo mensual", spendingByCategory: "Gastos por categoría",
    incomeByCategory: "Ingresos por categoría", noIncome: "No hay ingresos en este periodo.", viewAll: "Ver todos los movimientos",
  },
};
