#!/usr/bin/env node
// Builds llama.cpp's `llama-server` for 64-bit Android phones (CPU only) with the Android NDK, and puts it where the app is packaged so the phone
// can run it: src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libdorms_engine.so
//
// Android only lets an app start a program from the folder it unpacks its native libraries to, so the engine is shipped dressed as one
// (the file is a program, not a library). The app finds it next to its own library (see `engine_beside_app_library` in src-tauri/src/llama.rs)
// and starts it exactly like the desktop engine: the same arguments, the same local port.
//
// Env: NDK_HOME (or ANDROID_NDK_HOME) = the NDK, LLAMA_TAG (default: the same one build-llama.mjs uses).
// The build is for every 64-bit ARM phone (no dot-product or i8mm tuning), so it runs everywhere and is not the fastest it could be.
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const TAG = process.env.LLAMA_TAG || /const TAG = process\.env\.LLAMA_TAG \|\| "([^"]+)"/.exec(readFileSync(new URL("./build-llama.mjs", import.meta.url), "utf8"))?.[1] || "b12111";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, ".cache", "llama");
const src = join(cache, "src");
const build = join(cache, "android-arm64");
const ndk = process.env.NDK_HOME || process.env.ANDROID_NDK_HOME;
if (!ndk || !existsSync(join(ndk, "build", "cmake", "android.toolchain.cmake"))) throw new Error("Set NDK_HOME to the Android NDK.");
const out = join(root, "src-tauri", "gen", "android", "app", "src", "main", "jniLibs", "arm64-v8a", "libdorms_engine.so");

const run = (cmd, args) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
};

mkdirSync(cache, { recursive: true });
if (!existsSync(join(src, "CMakeLists.txt"))) run("git", ["clone", "--depth", "1", "--branch", TAG, "https://github.com/ggml-org/llama.cpp", src]);

// the engine's own web page is not used, but its build insists on downloading the page's files: a small stand-in keeps the build offline (as in build-llama.mjs)
const uiDist = join(src, "tools", "ui", "dist");
if (!existsSync(join(uiDist, "index.html"))) {
  mkdirSync(uiDist, { recursive: true });
  const stub = {
    "index.html": "<!doctype html><meta charset=utf-8><title>llama-server</title><p>The engine's own web page is not included.</p>",
    "manifest.webmanifest": "{}", "sw.js": "/* not used */", "build.json": "{}", "version.json": "{}",
    "bundle.stub.js": "/* not used */", "bundle.stub.css": "/* not used */", "workbox.stub.js": "/* not used */",
  };
  for (const [name, text] of Object.entries(stub)) writeFileSync(join(uiDist, name), text);
}

run("cmake", [
  "-S", src, "-B", build,
  `-DCMAKE_TOOLCHAIN_FILE=${join(ndk, "build", "cmake", "android.toolchain.cmake")}`,
  "-DANDROID_ABI=arm64-v8a", "-DANDROID_PLATFORM=android-28", "-DANDROID_STL=c++_static",
  "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF",
  "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", // never tune for the build machine; OpenMP isn't wanted on a phone
  "-DLLAMA_CURL=OFF", "-DLLAMA_BUILD_TESTS=OFF", "-DLLAMA_BUILD_EXAMPLES=OFF", "-DLLAMA_BUILD_SERVER=ON",
  "-DCMAKE_EXE_LINKER_FLAGS=-Wl,--strip-all",
]);
run("cmake", ["--build", build, "--target", "llama-server", "-j", String(os.cpus().length)]);

const bin = [join(build, "bin", "llama-server"), join(build, "llama-server")].find(existsSync);
if (!bin) throw new Error("llama-server was not produced.");
mkdirSync(dirname(out), { recursive: true });
copyFileSync(bin, out);
chmodSync(out, 0o755);

// make sure it really is a 64-bit ARM program (an ELF file whose machine is AArch64, 183)
const head = readFileSync(out).subarray(0, 20);
if (head.readUInt32BE(0) !== 0x7f454c46 || head.readUInt16LE(18) !== 183) throw new Error("The engine is not a 64-bit ARM program.");
console.log(`engine for 64-bit Android: ${out} (${(readFileSync(out).length / 1048576).toFixed(1)} MB)`);
