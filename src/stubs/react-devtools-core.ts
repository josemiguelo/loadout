// Ink imports react-devtools-core for its DEV-mode inspector, which the
// compiled binary never starts; this stub stands in (tsconfig.json's paths),
// so bun can bundle Ink without the package.
export default { initialize() {}, connectToDevTools() {} };
