import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    host: true,
    port: 5173,
    headers: {
      // Required for Rapier SharedArrayBuffer (WASM physics engine).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      '/diag': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  optimizeDeps: {
    // @react-three/rapier ships its own WASM loader; pre-bundling breaks it.
    exclude: ['@react-three/rapier'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        popup: resolve(__dirname, 'popup.html'),
      },
      output: {
        // Separate large vendor libs so game chunks stay lean and the browser
        // can cache them independently from application code.
        manualChunks(id: string) {
          // Physics engines — heaviest; isolate each so the browser can cache separately
          if (id.includes('@react-three/rapier') || id.includes('@dimforge/rapier3d-compat')) {
            return 'vendor-r3f-rapier';
          }
          // Three.js core + R3F ecosystem
          if (id.includes('@react-three/postprocessing')) return 'vendor-r3f-postprocessing';
          if (id.includes('@react-spring/three'))         return 'vendor-r3f-spring';
          if (id.includes('@react-three/drei'))           return 'vendor-drei';
          if (id.includes('@react-three/fiber'))          return 'vendor-r3f';
          if (id.includes('three'))                       return 'vendor-three';
          // Audio
          if (id.includes('tone'))                        return 'vendor-tone';
          // Physics (non-Rapier)
          if (id.includes('cannon-es'))                   return 'vendor-cannon';
          if (id.includes('matter-js'))                   return 'vendor-matter';
          // React core — kept tiny so it loads first
          if (id.includes('react-dom') || id.includes('react-router')) return 'vendor-react';
          if (id.includes('/react/'))                     return 'vendor-react';
          // Lucide icons — share across all game cards
          if (id.includes('lucide-react'))                return 'vendor-lucide';
        },
      },
    },
  },
});
