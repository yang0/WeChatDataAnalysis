#include <cstring>
extern "C" __declspec(dllexport) bool InitializeHook(unsigned long,const char*,const char*,int){return true;}
extern "C" __declspec(dllexport) bool PollKeyData(char* key,int n,char*,int){if(n>=65){std::memset(key,'a',64);key[64]=0;return true;}return false;}
extern "C" __declspec(dllexport) bool CleanupHook(){return true;}
