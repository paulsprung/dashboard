import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'shyy.dev | Smart Home Dashboard',
  description: 'Secure homelab operations dashboard'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
