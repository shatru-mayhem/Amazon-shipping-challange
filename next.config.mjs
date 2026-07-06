/** @type {import('next').NextConfig} */
const nextConfig = {
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
