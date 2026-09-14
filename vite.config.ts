import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import os from 'node:os';

import { viteStaticCopy } from 'vite-plugin-static-copy';

const https = (() => {
	try {
		return {
			cert: readFileSync('./certs/cert.pem'),
			key: readFileSync('./certs/key.pem')
		};
	} catch {
		return undefined;
	}
})();

const backendTarget =
	process.env.WEBUI_BACKEND_URL || (https ? 'https://localhost:8080' : 'http://localhost:8080');

const proxyToBackend = {
	target: backendTarget,
	changeOrigin: true,
	secure: false,
	ws: true
};

function lanIPv4(): string | undefined {
	const nets = os.networkInterfaces();
	const prefer = ['en0', 'en1', 'eth0', 'wlan0'];
	const isV4 = (a: os.NetworkInterfaceInfo) => a.family === 'IPv4' || (a.family as unknown) === 4;
	for (const name of prefer) {
		const found = nets[name]?.find((addr) => isV4(addr) && !addr.internal);
		if (found?.address) return found.address;
	}
	for (const addrs of Object.values(nets)) {
		const found = addrs?.find((addr) => isV4(addr) && !addr.internal);
		if (found?.address) return found.address;
	}
	return undefined;
}

function lanOriginPlugin(httpsEnabled: boolean): Plugin {
	const handle = (
		req: { url?: string; headers: { host?: string } },
		res: { setHeader: (k: string, v: string) => void; end: (body: string) => void },
		next: () => void
	) => {
		if (req.url?.split('?')[0] !== '/__lan-origin') {
			next();
			return;
		}
		const host = req.headers.host ?? 'localhost:5173';
		const port = host.includes(']:') ? host.split(']:')[1] : host.split(':').at(-1);
		const proto = httpsEnabled ? 'https' : 'http';
		const ip = lanIPv4() ?? null;
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Cache-Control', 'no-store');
		res.end(JSON.stringify({ ip, origin: ip ? `${proto}://${ip}:${port ?? '5173'}` : null }));
	};
	return {
		name: 'lan-origin',
		enforce: 'pre',
		configureServer(server) {
			server.middlewares.use(handle);
		},
		configurePreviewServer(server) {
			server.middlewares.use(handle);
		}
	};
}

export default defineConfig({
	plugins: [
		lanOriginPlugin(!!https),
		sveltekit(),
		viteStaticCopy({
			targets: [
				{
					src: 'node_modules/onnxruntime-web/dist/*.jsep.*',

					dest: 'wasm'
				}
			]
		})
	],
	define: {
		APP_VERSION: JSON.stringify(process.env.npm_package_version),
		APP_BUILD_HASH: JSON.stringify(process.env.APP_BUILD_HASH || 'dev-build')
	},
	server: {
		https,
		host: true,
		proxy: {
			'/api': proxyToBackend,
			'/ollama': proxyToBackend,
			'/openai': proxyToBackend,
			'/oauth': proxyToBackend,
			'/ws': proxyToBackend
		}
	},
	worker: {
		format: 'es'
	},
	esbuild: {
		pure: process.env.ENV === 'dev' ? [] : ['console.log', 'console.debug', 'console.error']
	}
});
