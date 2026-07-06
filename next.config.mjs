/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse (via pdfjs-dist) crashes when webpack bundles it into any
  // server-side chunk: "TypeError: Object.defineProperty called on
  // non-object" in pdfjs-dist's legacy ESM build's __esModule interop.
  // Excluding it from bundling makes Next require it natively at
  // runtime instead, which works fine (confirmed directly under plain
  // Node.js) — the failure is specifically a webpack/ESM bundling
  // incompatibility, not a runtime one.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "pdfjs-dist"],
  },
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      // pptxgenjs (client-side .pptx export) imports Node built-ins via the
      // node: scheme. Strip the scheme, then stub the modules out of the
      // browser bundle (its package.json "browser" field expects this).
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        https: false,
        http: false,
        os: false,
        path: false,
      };
    }
    return config;
  },
};
export default nextConfig;
