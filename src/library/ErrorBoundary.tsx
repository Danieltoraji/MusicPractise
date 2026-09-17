import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/** 关卡渲染兜底：任何组件运行时异常展示可读错误，不白屏（docs/02 §8 降级承诺） */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[boundary] 关卡渲染异常:', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="boundary-error">
          <h2>关卡运行出错</h2>
          <p className="muted">{this.state.error.message}</p>
          <button type="button" onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
