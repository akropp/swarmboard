import { html, render } from 'https://esm.sh/htm/preact/standalone';
import { useState, useEffect } from 'https://esm.sh/preact/hooks';
import { NavBar } from './components/common.js';
import { Dashboard } from './components/dashboard.js';
import { ProjectDetail } from './components/project.js';
import { ActivityFeed } from './components/activity.js';
import { SearchPage } from './components/search.js';

// ── Hash-based router ─────────────────────────────────────────────────────────

function parseHash(hash) {
  const h = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = h.split('?');
  const params = new URLSearchParams(queryPart || '');
  const segments = pathPart.split('/').filter(Boolean);
  return { path: pathPart || '/', segments, params };
}

function App() {
  const [loc, setLoc] = useState(() => parseHash(window.location.hash));

  useEffect(() => {
    function onHash() {
      setLoc(parseHash(window.location.hash));
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function navigate(path) {
    window.location.hash = '#' + path;
  }

  const { path, segments, params } = loc;

  // Render page based on route
  let page;
  if (path === '/' || path === '') {
    page = html`<${Dashboard} onNavigate=${navigate} />`;
  } else if (segments[0] === 'project' && segments[1]) {
    page = html`<${ProjectDetail} projectId=${segments[1]} onNavigate=${navigate} />`;
  } else if (segments[0] === 'activity') {
    page = html`<${ActivityFeed} onNavigate=${navigate} />`;
  } else if (segments[0] === 'search') {
    page = html`<${SearchPage} query=${params.get('q') || ''} onNavigate=${navigate} />`;
  } else {
    page = html`
      <div class="flex flex-col items-center justify-center h-64 text-muted">
        <div class="text-4xl mb-3">404</div>
        <p>Page not found</p>
        <button onclick=${() => navigate('/')} class="mt-4 text-accent hover:underline text-sm">← Go home</button>
      </div>
    `;
  }

  return html`
    <div class="min-h-screen">
      <${NavBar} onNavigate=${navigate} currentPath=${path} />
      <main>${page}</main>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
