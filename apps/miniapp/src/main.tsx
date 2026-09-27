import '@maxhub/max-ui/dist/styles.css';
import './organic.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from './api.js';
import { App } from './App.js';
import { createBridge, readLaunchContext } from './bridge.js';
import { ThemeProvider } from './theme.js';

const BOT_LINK = (import.meta.env.VITE_BOT_LINK as string | undefined) ?? 'https://max.ru/t750_hakaton_max_bot';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// Lora of the headings starts loading now, not when the first heading renders once the API has answered. «Ая » pulls
// both files: the letters the Cyrillic one, the space the Latin one. Not awaited: the app renders at once, in the
// fallback serif until the font arrives.
document.fonts?.load('700 1em Lora', 'Ая ').catch(() => {});

const launch = readLaunchContext(window.WebApp);
// Local development outside MAX: the API accepts X-Dev-User-Id only when NODE_ENV=development.
const devUserId = import.meta.env.DEV ? (import.meta.env.VITE_DEV_USER_ID as string | undefined) : undefined;
const api = launch ? createApiClient({ initData: launch.initData }) : devUserId ? createApiClient({ devUserId }) : null;
const startParam = launch?.startParam ?? (devUserId ? (new URLSearchParams(location.search).get('startapp') ?? undefined) : undefined);

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <App api={api} bridge={createBridge(window.WebApp)} startParam={startParam} botLink={BOT_LINK} />
    </ThemeProvider>
  </StrictMode>,
);
