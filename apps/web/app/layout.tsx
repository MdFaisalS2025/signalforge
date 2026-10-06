import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'SignalForge',
  description: 'Read-only incident dashboard for the local SignalForge demo',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
