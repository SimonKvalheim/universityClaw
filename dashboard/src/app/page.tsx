import { RagStatusCard } from './components/RagStatusCard';

export default function StatusPage() {
  return (
    <div>
      <h2 className="text-xl font-semibold mb-6">System Status</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">Pipeline</h3>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-900 text-green-300">
              Active
            </span>
          </div>
          <p className="text-2xl font-bold">Running</p>
          <p className="text-sm text-gray-500 mt-1">File watcher & ingestion pipeline</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">Telegram</h3>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-900 text-purple-300">
              Connected
            </span>
          </div>
          <p className="text-2xl font-bold">Online</p>
          <p className="text-sm text-gray-500 mt-1">Bot channel active</p>
        </div>

        <RagStatusCard />
      </div>
    </div>
  );
}
