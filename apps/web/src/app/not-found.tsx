'use client';
import { useEffect } from 'react';

/** Path-style links (/case/RG-1043, /customers/c1) from old builds or bookmarks: redirect to the query route instead of a 404. */
export default function NotFound() {
  useEffect(() => {
    const m = /^\/(case|customers)\/([^/?#]+)\/?$/.exec(window.location.pathname);
    if (m) window.location.replace(`/${m[1]}?id=${encodeURIComponent(decodeURIComponent(m[2]))}`);
  }, []);
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#F5F2EA', color: '#1B1A17', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 15, marginBottom: 8 }}>This page could not be found.</div>
        <a href="/" style={{ textDecoration: 'underline' }}>Go to Today</a>
      </div>
    </div>
  );
}
