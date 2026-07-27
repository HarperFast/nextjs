import { tables } from 'harper';

// Top-level await: Harper awaits component module evaluation, so the row is committed before the
// '@harperfast/nextjs' plugin (declared after this file in config.yaml) starts `next build`.
await tables.Dog.put({ id: 'rex', name: 'Rex' });
