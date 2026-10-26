/**
 * v4 内置样例的题型 builder 汇总（docs/51 §6：10 个题型，staff-click 含 clef 变体）。
 *
 * 每个 builder 返回独立的 `QuestionTypeDef`（每次调用新对象，勿共享可变引用）；
 * 10 个关卡 builder 按需组合使用，题型 id 即 builder 名（关卡内唯一）。
 */
export { buildButtonStepType } from './buttonStep'
export { buildSliderStepType } from './sliderStep'
export { buildChoiceListenType } from './choiceListen'
export { buildSynthDemoType } from './synthDemo'
export { buildStaffClickType, type StaffClickOptions, type StaffClickVariant } from './staffClick'
export { buildClefStaffClickType } from './clefStaffClick'
export { buildKeyboardMelodyType } from './keyboardMelody'
export { buildTextAnswerType } from './textAnswer'
export { buildChoiceTimedType } from './choiceTimed'
export { buildRhythmTapType } from './rhythmTap'
export { buildTunerTargetType } from './tunerTarget'
