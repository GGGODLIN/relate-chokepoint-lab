import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getBundledCatalog } from './contracts/catalog.ts';
import { ChokepointWorkerClient } from './engine/worker-client.ts';
import { App } from './ui/App.tsx';
import { fetchPayloadAsBlobUrl } from './ui/payload-loader.ts';
import { WorkbenchController } from './ui/workbench-controller.ts';
import './styles.css';

const catalog = getBundledCatalog();
const controller = new WorkbenchController(new ChokepointWorkerClient(), catalog);
void controller.start((onProgress) =>
  fetchPayloadAsBlobUrl(`${import.meta.env.BASE_URL}data/graph.wasm.json`, onProgress),
);

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root container');
}
createRoot(container).render(
  <StrictMode>
    <App controller={controller} catalog={catalog} />
  </StrictMode>,
);
