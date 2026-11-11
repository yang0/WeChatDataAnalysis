# Native key bridge provenance

The Windows DLL is built without Python or pybind11 from `H3CoF6/py_wx_key`, commit `f32e146647380a6ee14791cc5d4e279f9c480a41`. The exact source revision is pinned in CI. `CMakeLists.txt` lists the eight upstream C++ source files and statically links the MSVC runtime. `pybind_wrapper.cpp` and Python headers/libraries are excluded.

Original C ABI: `py_wx_key/include/hook_controller.h`. InitializeHook / PollKeyData / CleanupHook return C++ bool (one byte); the PowerShell C# delegates explicitly marshal it as I1. DLL SHA-256 and source revision are recorded in manifest.json, checked before loading. CI probes both the real DLL and a fake ABI fixture without injecting any real process, and uses dumpbin to reject Python DLL dependencies.

This repository does not claim a new license for the upstream component. Its source is public at the pinned revision without a root license file; the original py_wx_key source and its MinHook/Xbyak components retain their upstream terms. Do not apply this project's own code license to these components.
