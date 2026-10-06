import type { ReactNode } from 'react';

export type Section = 'incidents' | 'deployments' | 'demo';

// The dashboard frame: a left rail with the three sections, and the page content beside it. The rail is the only
// navigation. Below 960px, globals.css turns the rail into a top bar.
export function Shell({ current, children }: { current: Section; children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">SignalForge</div>
        <nav aria-label="Primary">
          <a href="/incidents" aria-current={current === 'incidents' ? 'page' : undefined}>
            Incidents
          </a>
          <a href="/deployments" aria-current={current === 'deployments' ? 'page' : undefined}>
            Deployments
          </a>
          <a href="/demo" aria-current={current === 'demo' ? 'page' : undefined}>
            Demo
          </a>
        </nav>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
