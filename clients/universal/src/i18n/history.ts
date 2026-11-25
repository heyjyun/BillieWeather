// Undo and Redo (components/HistoryControls.tsx). `actions` names an edit in the middle of a sentence.
const en = {
  label: "Undo and redo", undo: "Undo", redo: "Redo", undoTitle: "Undo: {edit}", redoTitle: "Redo: {edit}", nothingUndo: "Nothing to undo", nothingRedo: "Nothing to redo",
  one: "{action} “{description}”", many: "{action} ({count} entries)",
  undone: "Undone: {edit}.", redone: "Redone: {edit}.",
  conflict: "“{edit}” can no longer be reversed exactly, because something it touched has changed since. Nothing was changed.",
  gone: "Another change came first. Nothing was undone; check the button and try again.", failed: "That did not work. Nothing was changed; try again.",
  confirmUndo: "Undo “{edit}”? You can redo it until your next change.", confirmRedo: "Redo “{edit}”?",
  actions: {
    create: "new entry", edit: "edit", category: "category", kind: "type change", exclude: "excluded from totals", batch_edit: "batch edit", delete: "move to trash", restore: "restore from trash",
    duplicate: "copy", link: "linked entries", import: "import", reverse_import: "import removed", reclassify: "reclassification", organize: "AI suggestions applied", organize_undo: "AI suggestions undone",
    account: "account change", balance: "balance adjustment", category_list: "category list change", label_list: "merchant, project or tag change", budget: "budget change", schedule: "schedule change",
    post_schedule: "schedule posted", rule: "remembered merchant forgotten", region: "region change", settings: "book setting", command_undo: "undo of a command",
  },
};
export type HistoryCopy = typeof en;

export const historyCopy: Record<"en" | "zh-CN" | "zh-TW" | "ja" | "ko" | "es", HistoryCopy> = {
  en,
  "zh-CN": {
    label: "撤销和重做", undo: "撤销", redo: "重做", undoTitle: "撤销：{edit}", redoTitle: "重做：{edit}", nothingUndo: "没有可撤销的操作", nothingRedo: "没有可重做的操作",
    one: "{action}「{description}」", many: "{action}（{count} 条流水）",
    undone: "已撤销：{edit}。", redone: "已重做：{edit}。",
    conflict: "「{edit}」涉及的内容之后又有变动，无法再精确还原。没有做任何修改。",
    gone: "期间有了别的改动。没有撤销任何内容；请看清按钮后再试。", failed: "操作失败。没有做任何修改，请重试。",
    confirmUndo: "撤销「{edit}」？在下一次修改之前都可以重做。", confirmRedo: "重做「{edit}」？",
    actions: {
      create: "新增流水", edit: "编辑", category: "修改分类", kind: "修改类型", exclude: "是否计入统计", batch_edit: "批量编辑", delete: "移到回收站", restore: "从回收站恢复",
      duplicate: "复制", link: "关联流水", import: "导入", reverse_import: "撤销导入", reclassify: "重新分类", organize: "应用 AI 建议", organize_undo: "撤销 AI 建议",
      account: "修改账户", balance: "余额调整", category_list: "修改分类列表", label_list: "修改商家、项目或标签", budget: "修改预算", schedule: "修改周期记账",
      post_schedule: "周期记账入账", rule: "忘记商家规则", region: "修改地区", settings: "账本设置", command_undo: "撤销命令",
    },
  },
  "zh-TW": {
    label: "復原和重做", undo: "復原", redo: "重做", undoTitle: "復原：{edit}", redoTitle: "重做：{edit}", nothingUndo: "沒有可復原的操作", nothingRedo: "沒有可重做的操作",
    one: "{action}「{description}」", many: "{action}（{count} 筆紀錄）",
    undone: "已復原：{edit}。", redone: "已重做：{edit}。",
    conflict: "「{edit}」涉及的內容之後又有變動，無法再精確還原。沒有做任何修改。",
    gone: "期間有了別的變更。沒有復原任何內容；請看清按鈕後再試。", failed: "操作失敗。沒有做任何修改，請再試一次。",
    confirmUndo: "復原「{edit}」？在下一次修改之前都可以重做。", confirmRedo: "重做「{edit}」？",
    actions: {
      create: "新增紀錄", edit: "編輯", category: "修改分類", kind: "修改類型", exclude: "是否計入統計", batch_edit: "批次編輯", delete: "移到垃圾桶", restore: "從垃圾桶還原",
      duplicate: "複製", link: "連結紀錄", import: "匯入", reverse_import: "撤銷匯入", reclassify: "重新分類", organize: "套用 AI 建議", organize_undo: "復原 AI 建議",
      account: "修改帳戶", balance: "餘額調整", category_list: "修改分類清單", label_list: "修改商家、專案或標籤", budget: "修改預算", schedule: "修改週期記帳",
      post_schedule: "週期記帳入帳", rule: "忘記商家規則", region: "修改地區", settings: "帳本設定", command_undo: "復原指令",
    },
  },
  ja: {
    label: "取り消しとやり直し", undo: "取り消す", redo: "やり直す", undoTitle: "取り消す：{edit}", redoTitle: "やり直す：{edit}", nothingUndo: "取り消せる操作はありません", nothingRedo: "やり直せる操作はありません",
    one: "{action}「{description}」", many: "{action}（{count} 件）",
    undone: "取り消しました：{edit}", redone: "やり直しました：{edit}",
    conflict: "「{edit}」に関わる内容がその後変更されたため、正確に元へ戻せません。何も変更していません。",
    gone: "先に別の変更がありました。何も取り消していません。ボタンを確認してもう一度お試しください。", failed: "うまくいきませんでした。何も変更していません。もう一度お試しください。",
    confirmUndo: "「{edit}」を取り消しますか？次に変更するまではやり直せます。", confirmRedo: "「{edit}」をやり直しますか？",
    actions: {
      create: "記録の追加", edit: "編集", category: "カテゴリの変更", kind: "種類の変更", exclude: "集計対象の変更", batch_edit: "一括編集", delete: "ゴミ箱へ移動", restore: "ゴミ箱から復元",
      duplicate: "複製", link: "記録のリンク", import: "インポート", reverse_import: "インポートの取り消し", reclassify: "再分類", organize: "AI の提案の適用", organize_undo: "AI の提案の取り消し",
      account: "口座の変更", balance: "残高調整", category_list: "カテゴリ一覧の変更", label_list: "店舗・プロジェクト・タグの変更", budget: "予算の変更", schedule: "定期記帳の変更",
      post_schedule: "定期記帳の記録", rule: "店舗ルールの削除", region: "地域の変更", settings: "帳簿の設定", command_undo: "コマンドの取り消し",
    },
  },
  ko: {
    label: "실행 취소와 다시 실행", undo: "실행 취소", redo: "다시 실행", undoTitle: "실행 취소: {edit}", redoTitle: "다시 실행: {edit}", nothingUndo: "취소할 작업이 없습니다", nothingRedo: "다시 실행할 작업이 없습니다",
    one: "{action} “{description}”", many: "{action} ({count}건)",
    undone: "실행 취소함: {edit}", redone: "다시 실행함: {edit}",
    conflict: "“{edit}”에 포함된 내용이 그 뒤에 변경되어 더 이상 정확히 되돌릴 수 없습니다. 아무것도 변경하지 않았습니다.",
    gone: "그 사이 다른 변경이 있었습니다. 아무것도 취소하지 않았습니다. 버튼을 확인하고 다시 시도하세요.", failed: "작업하지 못했습니다. 아무것도 변경하지 않았습니다. 다시 시도하세요.",
    confirmUndo: "“{edit}”을(를) 취소할까요? 다음 변경 전까지 다시 실행할 수 있습니다.", confirmRedo: "“{edit}”을(를) 다시 실행할까요?",
    actions: {
      create: "새 내역", edit: "수정", category: "카테고리 변경", kind: "유형 변경", exclude: "합계 포함 변경", batch_edit: "일괄 수정", delete: "휴지통으로 이동", restore: "휴지통에서 복원",
      duplicate: "복사", link: "내역 연결", import: "가져오기", reverse_import: "가져오기 취소", reclassify: "재분류", organize: "AI 제안 적용", organize_undo: "AI 제안 취소",
      account: "계좌 변경", balance: "잔액 조정", category_list: "카테고리 목록 변경", label_list: "거래처·프로젝트·태그 변경", budget: "예산 변경", schedule: "반복 거래 변경",
      post_schedule: "반복 거래 기록", rule: "거래처 규칙 삭제", region: "지역 변경", settings: "장부 설정", command_undo: "명령 취소",
    },
  },
  es: {
    label: "Deshacer y rehacer", undo: "Deshacer", redo: "Rehacer", undoTitle: "Deshacer: {edit}", redoTitle: "Rehacer: {edit}", nothingUndo: "Nada que deshacer", nothingRedo: "Nada que rehacer",
    one: "{action} «{description}»", many: "{action} ({count} movimientos)",
    undone: "Deshecho: {edit}.", redone: "Rehecho: {edit}.",
    conflict: "«{edit}» ya no se puede revertir con exactitud porque algo que tocaba cambió después. No se modificó nada.",
    gone: "Hubo otro cambio antes. No se deshizo nada; revisa el botón e inténtalo de nuevo.", failed: "No funcionó. No se modificó nada; inténtalo de nuevo.",
    confirmUndo: "¿Deshacer «{edit}»? Podrás rehacerlo hasta tu próximo cambio.", confirmRedo: "¿Rehacer «{edit}»?",
    actions: {
      create: "nuevo movimiento", edit: "edición", category: "cambio de categoría", kind: "cambio de tipo", exclude: "cambio en los totales", batch_edit: "edición por lotes", delete: "mover a la papelera", restore: "restaurar de la papelera",
      duplicate: "copia", link: "movimientos vinculados", import: "importación", reverse_import: "importación deshecha", reclassify: "reclasificación", organize: "sugerencias de AI aplicadas", organize_undo: "sugerencias de AI deshechas",
      account: "cambio de cuenta", balance: "ajuste de saldo", category_list: "cambio en las categorías", label_list: "cambio de comercio, proyecto o etiqueta", budget: "cambio de presupuesto", schedule: "cambio de recurrente",
      post_schedule: "recurrente registrado", rule: "comercio olvidado", region: "cambio de región", settings: "ajuste del libro", command_undo: "deshacer un comando",
    },
  },
};
