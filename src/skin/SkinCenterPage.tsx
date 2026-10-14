/**
 * 皮肤中心（#/skins，docs/35 §4）：预设皮肤选择 + 背景图/水印/字体自定义。
 * 全部改动经 skin/store 的 updatePrefs 落地；图片与字体资产只存本机。
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  compressImageFile,
  deleteSkinFont,
  ensureSkinFontsLoaded,
  listSkinFonts,
  saveSkinFont,
  saveSkinImage,
  type SkinFont,
} from './assets'
import { SKIN_CATALOG, type WmPos } from './prefs'
import { clearBackground, clearWatermark, getSkinSnapshot, subscribeSkin, updatePrefs } from './store'

/** 本机字体候选（覆盖常见中文字体；检测结果仅作提示，选择本身不做硬限制） */
const LOCAL_FONT_CANDIDATES = [
  'Microsoft YaHei',
  '微软雅黑',
  'PingFang SC',
  'SimHei',
  '黑体',
  'KaiTi',
  '楷体',
  'SimSun',
  '宋体',
  'FangSong',
  '仿宋',
  'DengXian',
  '等线',
  'Noto Sans SC',
  'Source Han Sans SC',
  '思源黑体',
  '汉仪文黑85W',
  'HYWenHei 85W',
  'Segoe UI',
]

/** 画布测宽法探测本机字体可用性（启发式；canvas 不可用时视为可用不设限） */
function detectFontAvailable(family: string): boolean {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return true
  const text = 'mmmwww音乐练习 0123'
  ctx.font = '72px monospace'
  const baseMono = ctx.measureText(text).width
  ctx.font = `72px "${family}", monospace`
  const mono = ctx.measureText(text).width
  ctx.font = '72px sans-serif'
  const baseSans = ctx.measureText(text).width
  ctx.font = `72px "${family}", sans-serif`
  const sans = ctx.measureText(text).width
  return Math.abs(mono - baseMono) > 0.5 || Math.abs(sans - baseSans) > 0.5
}

const WM_POS_OPTIONS: { value: WmPos; label: string }[] = [
  { value: 'tile', label: '平铺' },
  { value: 'center', label: '居中' },
  { value: 'tl', label: '左上' },
  { value: 'tr', label: '右上' },
  { value: 'bl', label: '左下' },
  { value: 'br', label: '右下' },
]

export function SkinCenterPage() {
  const skin = useSyncExternalStore(subscribeSkin, getSkinSnapshot)
  const [notice, setNotice] = useState('')
  const [fonts, setFonts] = useState<SkinFont[]>([])
  const [customUi, setCustomUi] = useState('')
  const [customDisplay, setCustomDisplay] = useState('')

  const reloadFonts = useMemo(
    () => () => {
      void listSkinFonts().then((fs) => setFonts(fs.sort((a, b) => a.name.localeCompare(b.name))))
    },
    [],
  )
  useEffect(() => {
    reloadFonts()
  }, [reloadFonts])

  const localAvailability = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const f of LOCAL_FONT_CANDIDATES) map.set(f, detectFontAvailable(f))
    return map
  }, [])

  const onBgFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const { data, type } = await compressImageFile(file, 'bg')
      const id = await saveSkinImage(data, type)
      const old = getSkinSnapshot().bg.id
      updatePrefs({ bg: { ...getSkinSnapshot().bg, id } })
      if (old) await import('./assets').then((m) => m.deleteSkinImage(old).catch(() => undefined))
      setNotice('')
    } catch (err) {
      setNotice(`背景图保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const onWmFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const { data, type } = await compressImageFile(file, 'wm')
      const id = await saveSkinImage(data, type)
      const old = getSkinSnapshot().wm.id
      updatePrefs({ wm: { ...getSkinSnapshot().wm, id } })
      if (old) await import('./assets').then((m) => m.deleteSkinImage(old).catch(() => undefined))
      setNotice('')
    } catch (err) {
      setNotice(`水印保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const onFontFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const name = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 64)
      if (!name) throw new Error('文件名无法作为字体名')
      const data = await file.arrayBuffer()
      await saveSkinFont(name, data)
      await ensureSkinFontsLoaded()
      reloadFonts()
      setNotice(`字体「${name}」已导入并生效，可在下方槽位选用`)
    } catch (err) {
      setNotice(`字体导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const onRemoveFont = async (name: string) => {
    await deleteSkinFont(name)
    // 槽位正引用该字体时回退到跟随皮肤
    const s = getSkinSnapshot()
    if (s.font.ui === name || s.font.display === name) {
      updatePrefs({ font: { ...s.font, ui: s.font.ui === name ? null : s.font.ui, display: s.font.display === name ? null : s.font.display } })
    }
    reloadFonts()
  }

  /** select 值 ⇆ 槽位：空串 = 跟随皮肤；当前值不在候选里时补一个选项防 select 显示错位 */
  const slotOptions = (current: string | null) => {
    const extra =
      current && !LOCAL_FONT_CANDIDATES.includes(current) && !fonts.some((f) => f.name === current)
        ? [<option key="cur" value={current}>{current}</option>]
        : []
    return (
      <>
        <option value="">跟随皮肤</option>
        {extra}
        <optgroup label="本机字体">
          {LOCAL_FONT_CANDIDATES.map((f) => (
            <option key={f} value={f}>
              {f}
              {localAvailability.get(f) ? '' : '（未检测到）'}
            </option>
          ))}
        </optgroup>
        {fonts.length > 0 && (
          <optgroup label="已导入字体">
            {fonts.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </optgroup>
        )}
      </>
    )
  }

  return (
    <div className="page skin-page">
      <h1>皮肤中心</h1>
      <p className="muted">
        换配色、换字体，再叠加自己的背景图与水印。皮肤差异主要是配色和字体；自定义部分叠加在所选皮肤之上。
        <b>外观仅保存在本机浏览器，不随账户同步。</b>
      </p>

      <h2>预设皮肤</h2>
      <div className="skin-cards">
        {SKIN_CATALOG.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`skin-card${skin.skinId === s.id ? ' active' : ''}`}
            onClick={() => updatePrefs({ skinId: s.id })}
          >
            <span className={`skin-preview skin-preview-${s.id}`} aria-hidden="true">
              <span className="skin-preview-side" />
              <span className="skin-preview-main">
                <span className="skin-preview-title">Aa 音乐练习</span>
                <span className="skin-preview-line" />
                <span className="skin-preview-line short" />
                <span className="skin-preview-chip" />
              </span>
            </span>
            <span className="skin-card-name">
              {s.name}
              {skin.skinId === s.id && <em className="skin-card-current">当前</em>}
            </span>
            <span className="skin-card-desc">{s.desc}</span>
            <span className="skin-card-font">{s.fontNote}</span>
          </button>
        ))}
      </div>

      <h2>背景图</h2>
      <div className="skin-panel">
        <div className="skin-row">
          <label className="skin-field">
            显示范围
            <select value={skin.bg.scope} onChange={(e) => updatePrefs({ bg: { ...skin.bg, scope: e.target.value as 'all' | 'home' } })}>
              <option value="all">整体界面</option>
              <option value="home">仅首页（主界面）</option>
            </select>
          </label>
          <label className="skin-field skin-field-grow">
            图片不透明度：{Math.round(skin.bg.opacity * 100)}%
            <input
              type="range"
              min={10}
              max={100}
              value={Math.round(skin.bg.opacity * 100)}
              onChange={(e) => updatePrefs({ bg: { ...skin.bg, opacity: Number(e.target.value) / 100 } })}
            />
          </label>
        </div>
        <div className="skin-row">
          {skin.rt.bgUrl && <img className="skin-thumb" src={skin.rt.bgUrl} alt="背景图预览" />}
          <label className="button-like skin-upload">
            <input type="file" accept="image/*" onChange={onBgFile} />
            {skin.bg.id ? '更换背景图' : '上传背景图'}
          </label>
          {skin.bg.id && (
            <button type="button" onClick={() => void clearBackground()}>
              移除
            </button>
          )}
        </div>
        <p className="muted skin-note">设置后整体（或首页）的默认背景色将被图片替代；仅本机生效，不同步云端。</p>
      </div>

      <h2>水印图</h2>
      <div className="skin-panel">
        <p className="muted skin-note-top">水印叠加在背景色/背景图之上、界面元素之下，可用作界面装饰。</p>
        <div className="skin-row">
          <label className="skin-field">
            显示位置
            <select value={skin.wm.pos} onChange={(e) => updatePrefs({ wm: { ...skin.wm, pos: e.target.value as WmPos } })}>
              {WM_POS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="skin-field skin-field-grow">
            不透明度：{Math.round(skin.wm.opacity * 100)}%
            <input
              type="range"
              min={5}
              max={100}
              value={Math.round(skin.wm.opacity * 100)}
              onChange={(e) => updatePrefs({ wm: { ...skin.wm, opacity: Number(e.target.value) / 100 } })}
            />
          </label>
          <label className="skin-field skin-field-grow">
            四周渐隐：{skin.wm.fade}%
            <input
              type="range"
              min={0}
              max={100}
              value={skin.wm.fade}
              onChange={(e) => updatePrefs({ wm: { ...skin.wm, fade: Number(e.target.value) } })}
            />
          </label>
        </div>
        <div className="skin-row">
          {skin.rt.wmUrl && <img className="skin-thumb" src={skin.rt.wmUrl} alt="水印预览" />}
          <label className="button-like skin-upload">
            <input type="file" accept="image/*" onChange={onWmFile} />
            {skin.wm.id ? '更换水印图' : '上传水印图'}
          </label>
          {skin.wm.id && (
            <button type="button" onClick={() => void clearWatermark()}>
              移除
            </button>
          )}
        </div>
        <p className="muted skin-note">仅本机生效，不同步云端。</p>
      </div>

      <h2>字体</h2>
      <div className="skin-panel">
        <div className="skin-row">
          <label className="skin-field skin-field-grow">
            界面字体
            <select value={skin.font.ui ?? ''} onChange={(e) => updatePrefs({ font: { ...skin.font, ui: e.target.value || null } })}>
              {slotOptions(skin.font.ui)}
            </select>
          </label>
          <span className="skin-field skin-field-grow">
            或输入字体名
            <span className="skin-custom-row">
              <input
                value={customUi}
                placeholder="本机已安装的字体 family"
                onChange={(e) => setCustomUi(e.target.value)}
              />
              <button
                type="button"
                disabled={!customUi.trim()}
                onClick={() => updatePrefs({ font: { ...skin.font, ui: customUi.trim() || null } })}
              >
                应用
              </button>
            </span>
          </span>
        </div>
        <div className="skin-row">
          <label className="skin-field skin-field-grow">
            标题字体
            <select
              value={skin.font.display ?? ''}
              onChange={(e) => updatePrefs({ font: { ...skin.font, display: e.target.value || null } })}
            >
              {slotOptions(skin.font.display)}
            </select>
          </label>
          <span className="skin-field skin-field-grow">
            或输入字体名
            <span className="skin-custom-row">
              <input
                value={customDisplay}
                placeholder="本机已安装的字体 family"
                onChange={(e) => setCustomDisplay(e.target.value)}
              />
              <button
                type="button"
                disabled={!customDisplay.trim()}
                onClick={() => updatePrefs({ font: { ...skin.font, display: customDisplay.trim() || null } })}
              >
                应用
              </button>
            </span>
          </span>
        </div>
        <div className="skin-row">
          <label className="button-like skin-upload">
            <input type="file" accept=".woff,.woff2,.ttf,.otf" onChange={onFontFile} />
            导入字体文件（woff/woff2/ttf/otf）
          </label>
          {fonts.length > 0 && (
            <span className="skin-fonts">
              {fonts.map((f) => (
                <span key={f.name} className="skin-font-chip">
                  {f.name}
                  <button type="button" title={`删除字体 ${f.name}`} onClick={() => void onRemoveFont(f.name)}>
                    ✕
                  </button>
                </span>
              ))}
            </span>
          )}
        </div>
        <p className="muted skin-note">
          本机字体缺失时自动回退到系统字体；皮肤「堇庭流华」的标题字体（汉仪文黑85W）未安装时会回退，可在此导入字体文件后于「标题字体」槽位选用。导入的字体仅存本机。
        </p>
      </div>

      {notice && <p className="skin-notice">{notice}</p>}
    </div>
  )
}
