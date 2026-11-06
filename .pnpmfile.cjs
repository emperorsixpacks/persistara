// crypto-browser 0.1.8 redundantly lists curves ^1.6 as dependency and peer.
// Its parent uses curves 2, causing pnpm to substitute the incompatible peer.
// Keep the module's declared direct dependency and remove only that redundant peer.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "@freedomofpress/crypto-browser" && pkg.version === "0.1.8") {
        delete pkg.peerDependencies?.["@noble/curves"];
      }
      return pkg;
    },
  },
};
