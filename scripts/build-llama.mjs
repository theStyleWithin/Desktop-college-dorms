#!/usr/bin/env node
// Builds llama.cpp's `llama-server` as a single static binary (no DLLs/.so
// files to ship) and places it where Tauri's `externalBin` expects it:
//   src-tauri/binaries/dorms-engine-<target-triple>[.exe]          (CPU)
//   src-tauri/binaries/dorms-engine-vulkan-<target-triple>[.exe]   (GPU via Vulkan)
// (named dorms-engine so it never collides with a distro's own llama-server)
//
// Env: LLAMA_TAG (default pinned below), SKIP_VULKAN=1 to skip the GPU build,
//      TARGET_TRIPLE to override the host triple.
// The app tries the Vulkan binary first and falls back to the CPU one, so if
// the Vulkan build is skipped or fails a harmless stub is installed instead.
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const TAG = process.env.LLAMA_TAG || "b12111";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, ".cache", "llama");
const src = join(cache, "src");
const outDir = join(root, "src-tauri", "binaries");
const isWin = process.platform === "win32";
const exe = isWin ? ".exe" : "";

const triple =
  process.env.TARGET_TRIPLE ||
  /host: (\S+)/.exec(execSync("rustc -vV", { encoding: "utf8" }))[1];
const x86 = /^(x86_64|i686)/.test(triple);

const run = (cmd, args, opts = {}) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
};

mkdirSync(cache, { recursive: true });
mkdirSync(outDir, { recursive: true });
if (!existsSync(join(src, "CMakeLists.txt"))) {
  run("git", ["clone", "--depth", "1", "--branch", TAG, "https://github.com/ggml-org/llama.cpp", src]);
}

function build(dir, extra) {
  const flags = [
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DGGML_NATIVE=OFF", // never tune for the build machine: this ships to other PCs
    "-DLLAMA_CURL=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_SERVER=ON",
    ...extra,
  ];
  // x86-64-v3 baseline (AVX2/FMA, Haswell 2013+, Steam Deck, any CachyOS-capable CPU)
  if (x86) flags.push("-DGGML_AVX2=ON", "-DGGML_FMA=ON", "-DGGML_F16C=ON", "-DGGML_BMI2=ON");
  if (process.platform === "linux") {
    flags.push("-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc");
  }
  if (isWin) flags.push("-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded");
  const b = join(cache, dir);
  run("cmake", ["-S", src, "-B", b, ...flags]);
  run("cmake", ["--build", b, "--config", "Release", "-j", String(os.cpus().length), "--target", "llama-server"]);
  const candidates = [join(b, "bin", "Release", `llama-server${exe}`), join(b, "bin", `llama-server${exe}`)];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`llama-server not found after build in ${b}`);
  return found;
}

const cpuOut = join(outDir, `dorms-engine-${triple}${exe}`);
copyFileSync(build("build-cpu", []), cpuOut);
if (!isWin) chmodSync(cpuOut, 0o755);
console.log(`CPU server -> ${cpuOut}`);

rmSync(join(outDir, ".vulkan-ok"), { force: true });
const vkOut = join(outDir, `dorms-engine-vulkan-${triple}${exe}`);
let vulkanOk = false;
if (!process.env.SKIP_VULKAN && !/apple|android/.test(triple)) {
  try {
    copyFileSync(build("build-vulkan", ["-DGGML_VULKAN=ON"]), vkOut);
    if (!isWin) chmodSync(vkOut, 0o755);
    vulkanOk = true;
    writeFileSync(join(outDir, ".vulkan-ok"), triple);
    console.log(`Vulkan server -> ${vkOut}`);
  } catch (e) {
    console.warn(`Vulkan build failed, shipping CPU only: ${e.message}`);
  }
}
if (!vulkanOk) {
  // Stub that fails immediately; the app then falls back to the CPU binary.
  if (isWin) copyFileSync(cpuOut, vkOut);
  else {
    writeFileSync(vkOut, "#!/bin/sh\nexit 1\n");
    chmodSync(vkOut, 0o755);
  }
  console.log(`Vulkan stub -> ${vkOut}`);
}
