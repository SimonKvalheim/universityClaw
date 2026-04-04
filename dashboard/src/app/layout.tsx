import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'universityClaw', description: 'Teaching Assistant Dashboard' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <nav className="border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-8">
            <h1 className="text-lg font-semibold">universityClaw</h1>
            <div className="flex gap-6 text-sm text-gray-400">
              <a href="/" className="hover:text-gray-100">Status</a>
              <a href="/upload" className="hover:text-gray-100">Upload</a>
              <a href="/vault" className="hover:text-gray-100">Vault</a>
              <a href="/read" className="hover:text-gray-100">Read</a>
            </div>
          </div>
        </nav>
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
