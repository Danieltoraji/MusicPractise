import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 兜底标题（默认「关卡运行出错」；编辑器子区域/路由级传更准确的名称） */
  title?: string
  /**
   * 恢复动作形态：retry = 「重试」（重挂子树，编辑器子区域默认）；
   * page = 「重新加载页面 + 返回首页」（路由级 lazy chunk 404 等场景，重挂子树无效）
   */
  actions?: 'retry' | 'page'
}

interface State {
  error: Error | null
}

/** 渲染兜底：任何组件运行时异常展示可读错误，不白屏（docs/02 §8 降级承诺） */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[boundary] 渲染异常:', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="boundary-error boundary-runtime">
          <h2>{this.props.title ?? '关卡运行出错'}</h2>
          <p className="muted">{this.state.error.message}</p>
          {this.props.actions === 'page' ? (
            <>
              {/* lazy chunk 失效（部署后旧 hash 引用 404）重挂无效，整页重载拿新构建 */}
              <button type="button" onClick={() => window.location.reload()}>
                重新加载页面
              </button>{' '}
              <button type="button" onClick={() => (window.location.hash = '#/')}>
                返回首页
              </button>
            </>
          ) : (
            <button type="button" onClick={() => this.setState({ error: null })}>
              重试
            </button>
          )}
        </div>
      )
    }
    return this.props.children
  }
}
