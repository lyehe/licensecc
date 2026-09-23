using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace Licensecc.Client.DeviceBound;

internal enum Call { Activate, Renew, Authorize, SaveCheckpoint, AbandonPending }
internal unsafe interface INativeApi : IDisposable
{
    IDisposable Pin();
    Abi.Options Options(); Abi.Outcome Outcome(); Abi.View View();
    int Open(bool resume,Abi.Options* options,IntPtr* handle,Abi.Outcome* outcome);
    int Invoke(Call call,IntPtr handle,Abi.Outcome* outcome);
    int Prepare(IntPtr handle,Abi.View* view);
    int Launch(IntPtr handle); int Poll(IntPtr handle,uint wait); int Cancel(IntPtr handle);
    void Close(IntPtr handle);
}

internal sealed unsafe partial class NativeApi : INativeApi
{
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint Probe(uint index);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void InitOptions(Abi.Options* value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void InitOutcome(Abi.Outcome* value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void InitView(Abi.View* value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int OpenCall(Abi.Options* options,IntPtr* handle,Abi.Outcome* outcome);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int OutcomeCall(IntPtr handle,Abi.Outcome* outcome);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int PrepareCall(IntPtr handle,Abi.View* view);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int HandleCall(IntPtr handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int PollCall(IntPtr handle,uint wait);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void CloseCall(IntPtr handle);
    private readonly Module module;
    private readonly InitOptions initOptions; private readonly InitOutcome initOutcome; private readonly InitView initView;
    private readonly OpenCall enrollment, resume;
    private readonly OutcomeCall[] calls;
    private readonly PrepareCall prepare;
    private readonly HandleCall launch, cancel;
    private readonly PollCall poll;
    private readonly CloseCall close;

    internal NativeApi(string absoluteDllPath)
    {
        if((!OperatingSystem.IsWindows() && !OperatingSystem.IsLinux()) || IntPtr.Size != 8)
            throw new PlatformNotSupportedException("The protected bridge requires 64-bit Windows or Linux.");
        if(string.IsNullOrEmpty(absoluteDllPath) || !Path.IsPathFullyQualified(absoluteDllPath) || absoluteDllPath.Contains('\0'))
            throw new ArgumentException("Supply an application-owned absolute DLL path.",nameof(absoluteDllPath));
        var path=Path.GetFullPath(absoluteDllPath);
        if(!File.Exists(path)) throw new FileNotFoundException("Native bridge not found.",path);
        module=new Module(path);
        try
        {
            T Export<T>(string name) where T : Delegate => Marshal.GetDelegateForFunctionPointer<T>(NativeLibrary.GetExport(module.DangerousGetHandle(),name));
            var probe=Export<Probe>("lcc_device_bound_bridge_layout"); Abi.Verify(index=>probe(index));
            initOptions=Export<InitOptions>("lcc_init_device_bound_options");
            initOutcome=Export<InitOutcome>("lcc_init_device_bound_outcome"); initView=Export<InitView>("lcc_init_device_bound_view");
            enrollment=Export<OpenCall>("lcc_device_bound_open_enrollment"); resume=Export<OpenCall>("lcc_device_bound_open_resume");
            calls=new[]{Export<OutcomeCall>("lcc_device_bound_activate"),Export<OutcomeCall>("lcc_device_bound_renew"),
                Export<OutcomeCall>("lcc_device_bound_authorize"),Export<OutcomeCall>("lcc_device_bound_save_checkpoint"),Export<OutcomeCall>("lcc_device_bound_abandon_pending")};
            prepare=Export<PrepareCall>("lcc_device_bound_prepare"); launch=Export<HandleCall>("lcc_device_bound_launch");
            poll=Export<PollCall>("lcc_device_bound_poll"); cancel=Export<HandleCall>("lcc_device_bound_cancel"); close=Export<CloseCall>("lcc_device_bound_close");
        }
        catch { module.Dispose(); throw; }
    }
    public IDisposable Pin() => new ModulePin(module);
    public Abi.Options Options() { Abi.Options value=default; initOptions(&value); return value; }
    public Abi.Outcome Outcome() { Abi.Outcome value=default; initOutcome(&value); return value; }
    public Abi.View View() { Abi.View value=default; initView(&value); return value; }
    public int Open(bool existing,Abi.Options* options,IntPtr* handle,Abi.Outcome* outcome) => (existing?resume:enrollment)(options,handle,outcome);
    public int Invoke(Call call,IntPtr handle,Abi.Outcome* outcome) => calls[(int)call](handle,outcome);
    public int Prepare(IntPtr handle,Abi.View* view) => prepare(handle,view);
    public int Launch(IntPtr handle) => launch(handle);
    public int Poll(IntPtr handle,uint wait) => poll(handle,wait);
    public int Cancel(IntPtr handle) => cancel(handle);
    public void Close(IntPtr handle) => close(handle);
    public void Dispose() => module.Dispose();

    private sealed class Module : SafeHandle
    {
        // Exact Win32 loader flags: dependency directory plus System32 only.
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
        private static extern IntPtr LoadLibraryExW(string path,IntPtr file,uint flags);
        // NativeLibrary.Load exposes no flags on Linux, so it cannot request eager binding.
        // P/Invoke dlopen directly instead; "libc" resolves to libc.so.6 via the runtime's
        // built-in Unix library-name probing.
        private const int RTLD_NOW=2, RTLD_LOCAL=0;
        [DllImport("libc",EntryPoint="dlopen")] private static extern IntPtr dlopen(string file,int mode);
        [DllImport("libc",EntryPoint="dlerror")] private static extern IntPtr dlerror();
        internal Module(string path) : base(IntPtr.Zero,true)
        {
            if(OperatingSystem.IsWindows())
            {
                SetHandle(LoadLibraryExW(path,IntPtr.Zero,0x00000100|0x00000800));
                if(IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            else
            {
                // dlopen failures surface as DllNotFoundException with the loader message.
                // Bind eagerly (RTLD_NOW) like the Python bridge so missing TPM2/OpenSSL symbols fail at load.
                // dlerror() reports the most recent failure and is cleared by any other dynamic-linker
                // activity on this thread, so: (1) call it once, unconditionally, before dlopen so the
                // P/Invoke stub for dlerror is already resolved (first-time symbol resolution via dlsym
                // would otherwise clear the real error we read afterward), and (2) read it back
                // immediately on failure, before any other call, including SafeHandle bookkeeping.
                dlerror();
                var native=dlopen(path,RTLD_NOW|RTLD_LOCAL);
                if(native==IntPtr.Zero)
                {
                    var message=Marshal.PtrToStringAnsi(dlerror());
                    throw new DllNotFoundException(string.IsNullOrEmpty(message)?$"Unable to load shared library '{path}'.":message);
                }
                SetHandle(native);
            }
        }
        public override bool IsInvalid => handle==IntPtr.Zero;
        protected override bool ReleaseHandle() { NativeLibrary.Free(handle); return true; }
    }
    private sealed class ModulePin : IDisposable
    {
        private Module? module;
        internal ModulePin(Module value)
        {
            bool added=false; value.DangerousAddRef(ref added);
            if(added) module=value;
        }
        public void Dispose() => System.Threading.Interlocked.Exchange(ref module,null)?.DangerousRelease();
    }
}
