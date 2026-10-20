// Entry point bundled into public/vendor/collab.js (npm run build).
export { Editor } from '@tiptap/core';
export { default as Collaboration } from '@tiptap/extension-collaboration';
export { default as CollaborationCursor } from '@tiptap/extension-collaboration-cursor';
export { default as Placeholder } from '@tiptap/extension-placeholder';
export { docExtensions, FONTS } from '../shared/doc-schema.js';
export * as Y from 'yjs';
export { WebsocketProvider } from 'y-websocket';
