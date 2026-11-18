// Messages for the in-app Welcome page (src/pages/Welcome.tsx), in every interface language.
// English is the reference; test/i18n.test.ts checks that each language has the same keys and placeholders.

export const welcomeEn = {
  greeting: "Hi, {name}",
  ready: "Your account is ready",
  title: "Welcome to BillieWeather!",
  subtitle: "Your money, a little clearer every day.",
  stepsLabel: "How BillieWeather works",
  step: "Step {n}",
  steps: {
    import: { title: "Bring your finances together", body: "Import statements and receipts securely." },
    organize: { title: "Let AI organize the details", body: "Review smart transaction categorization." },
    forecast: { title: "See what's coming", body: "Explore your cash-flow forecast." },
  },
  start: "Get Started",
  explore: "Explore Dashboard",
  privacy: "Your financial data stays on this device unless you choose to sync it.",
};

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
export type WelcomeMessages = Widen<typeof welcomeEn>;

export const welcomeZhCN: WelcomeMessages = {
  greeting: "你好，{name}",
  ready: "你的账户已准备就绪",
  title: "欢迎使用 BillieWeather！",
  subtitle: "让你的财务，每天都更清晰一点。",
  stepsLabel: "BillieWeather 如何使用",
  step: "第 {n} 步",
  steps: {
    import: { title: "汇集你的财务信息", body: "安全地导入账单和小票。" },
    organize: { title: "让 AI 整理细节", body: "查看智能交易分类结果。" },
    forecast: { title: "预见未来", body: "探索你的现金流预测。" },
  },
  start: "开始使用",
  explore: "浏览财务总览",
  privacy: "除非你主动同步，财务数据只保存在本机。",
};

export const welcomeZhTW: WelcomeMessages = {
  greeting: "你好，{name}",
  ready: "你的帳戶已準備就緒",
  title: "歡迎使用 BillieWeather！",
  subtitle: "讓你的財務，每天都更清晰一點。",
  stepsLabel: "BillieWeather 如何使用",
  step: "第 {n} 步",
  steps: {
    import: { title: "匯集你的財務資訊", body: "安全地匯入帳單和收據。" },
    organize: { title: "讓 AI 整理細節", body: "檢視智慧交易分類結果。" },
    forecast: { title: "預見未來", body: "探索你的現金流預測。" },
  },
  start: "開始使用",
  explore: "瀏覽財務總覽",
  privacy: "除非你主動同步，財務資料只保存在本機。",
};

export const welcomeJa: WelcomeMessages = {
  greeting: "こんにちは、{name} さん",
  ready: "アカウントの準備ができました",
  title: "BillieWeather へようこそ！",
  subtitle: "あなたのお金を、毎日少しずつクリアに。",
  stepsLabel: "BillieWeather の使い方",
  step: "ステップ {n}",
  steps: {
    import: { title: "お金の情報をひとつに", body: "明細書やレシートを安全に取り込みます。" },
    organize: { title: "細かな整理は AI におまかせ", body: "取引のスマートな分類を確認します。" },
    forecast: { title: "これからを見通す", body: "キャッシュフロー予測を見てみましょう。" },
  },
  start: "はじめる",
  explore: "ダッシュボードを見る",
  privacy: "同期を選ばない限り、財務データはこのデバイスにだけ保存されます。",
};

export const welcomeKo: WelcomeMessages = {
  greeting: "안녕하세요, {name}님",
  ready: "계정이 준비되었습니다",
  title: "BillieWeather에 오신 것을 환영합니다!",
  subtitle: "매일 조금씩 더 선명해지는 나의 돈.",
  stepsLabel: "BillieWeather 사용 방법",
  step: "{n}단계",
  steps: {
    import: { title: "재정 정보를 한곳에", body: "명세서와 영수증을 안전하게 가져옵니다." },
    organize: { title: "세부 정리는 AI에게", body: "스마트 거래 분류를 확인합니다." },
    forecast: { title: "앞으로를 내다보기", body: "현금 흐름 예측을 살펴봅니다." },
  },
  start: "시작하기",
  explore: "대시보드 둘러보기",
  privacy: "동기화를 선택하지 않는 한 재정 데이터는 이 기기에만 저장됩니다.",
};

export const welcomeEs: WelcomeMessages = {
  greeting: "Hola, {name}",
  ready: "Tu cuenta está lista",
  title: "¡Te damos la bienvenida a BillieWeather!",
  subtitle: "Tu dinero, un poco más claro cada día.",
  stepsLabel: "Cómo funciona BillieWeather",
  step: "Paso {n}",
  steps: {
    import: { title: "Reúne tus finanzas", body: "Importa extractos y recibos de forma segura." },
    organize: { title: "Deja que la IA ordene los detalles", body: "Revisa la categorización inteligente de transacciones." },
    forecast: { title: "Mira lo que viene", body: "Explora tu previsión de flujo de caja." },
  },
  start: "Empezar",
  explore: "Ver el panel",
  privacy: "Tus datos financieros se quedan en este dispositivo salvo que decidas sincronizarlos.",
};
