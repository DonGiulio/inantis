import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: 'src/web',
  plugins: [vue()],
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:43883', changeOrigin: false } },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
