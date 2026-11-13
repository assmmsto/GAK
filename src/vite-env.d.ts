// رقم الإصدار يُحقن وقت البناء من package.json (vite.config.ts → define).
// تعريفه هنا حتى يراه TypeScript بلا أي حزمة أنواع إضافية.
declare const __APP_VERSION__: string;
