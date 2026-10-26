/**
 * schema 上限常量（docs/40 A5 门禁）：与 `schemas/v4/level.json`、`schemas/v1/common.json` 的
 * maxItems/maxLength 对齐——编辑器在添加入口就地 disabled + 计数，而不是到保存才被拒。
 * 改 schema 上限时同步此处（D6 一致性测试 guard：schemaLimits.test.ts）。
 */

export const SCHEMA_LIMITS = {
  /** level.json content.components maxItems */
  components: 64,
  /** level.json content.views maxItems */
  views: 32,
  /** level.json content.table.columns maxItems */
  tableColumns: 32,
  /** level.json content.table.rows maxItems */
  tableRows: 512,
  /** common.json NoteList maxItems（单元格音符数） */
  notesPerCell: 64,
  /** common.json 列 key/label maxLength */
  columnKeyMaxLength: 32,
  columnLabelMaxLength: 24,
} as const
