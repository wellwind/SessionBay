import { Component, Fragment } from 'react';
import type { ReactNode } from 'react';

/** A broken file preview must not unmount the workspace, terminal, or file tabs. */
export class FilePreviewBoundary extends Component<{ path: string; children: ReactNode }, { failed: boolean; retry: number }> {
  state = { failed: false, retry: 0 };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error) { console.error('File preview rendering failed', error); }

  render() {
    if (this.state.failed) return <div className="explorer-empty" role="alert">
      <p>無法顯示檔案預覽：{this.props.path}</p>
      <button onClick={() => this.setState(state => ({ failed: false, retry: state.retry + 1 }))}>重試</button>
    </div>;
    return <Fragment key={this.state.retry}>{this.props.children}</Fragment>;
  }
}
