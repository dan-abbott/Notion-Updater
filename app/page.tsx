'use client';

import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="wrap">
      <h1>Notion-Updater</h1>
      <p className="lede">Connect a Notion page to a Google Sheet, so a button click keeps charts and tables in sync.</p>

      <div className="cards">
        <Link href="/setup" className="card">
          <h2>Set up a new connector</h2>
          <p>Walk through deploying a script, mapping your data, and wiring up a Notion button — five steps, start to finish.</p>
          <span className="cardAction">Start the wizard →</span>
        </Link>

        <Link href="/admin" className="card">
          <h2>Manage existing connectors</h2>
          <p>View, edit, or remove connectors — or jump into a connector's mapping to add, change, or remove fields.</p>
          <span className="cardAction">Open admin →</span>
        </Link>
      </div>

      <style jsx global>{`
        .wrap {
          max-width: 720px;
          margin: 0 auto;
          padding: 60px 24px 80px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: #1a1a1a;
        }
        h1 {
          font-size: 30px;
          margin-bottom: 6px;
        }
        .lede {
          color: #555;
          margin-bottom: 40px;
          max-width: 56ch;
        }
        .cards {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .card {
          display: block;
          padding: 22px 24px;
          border-radius: 12px;
          background: white;
          box-shadow: 0 1px 3px rgba(30, 30, 60, 0.1);
          text-decoration: none;
          color: inherit;
          transition: box-shadow 0.15s ease, transform 0.15s ease;
        }
        .card:hover {
          box-shadow: 0 4px 14px rgba(30, 30, 60, 0.14);
          transform: translateY(-1px);
        }
        .card h2 {
          font-size: 18px;
          margin: 0 0 6px;
          color: #1a1a1a;
        }
        .card p {
          font-size: 14px;
          color: #666;
          margin: 0 0 12px;
        }
        .cardAction {
          font-size: 13px;
          font-weight: 600;
          color: #5b3fd6;
        }
      `}</style>
    </main>
  );
}
