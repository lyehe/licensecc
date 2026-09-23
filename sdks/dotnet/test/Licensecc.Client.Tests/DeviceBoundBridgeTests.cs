using System;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Licensecc.Client.DeviceBound;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Licensecc.Client.Tests;

[TestClass]
public sealed unsafe class DeviceBoundBridgeTests
{
    private static Configuration Config(string label="Workstation",TrustedSigner[]? keys=null,string project="CAD") =>
        new("com.example.cad","https://backend.test","https://portal.test/authorize","https://issuer.test/",
            "CAD-client","proof-audience",project,"DEFAULT","CAD-client",label,keys??new[]{new TrustedSigner(new byte[]{1})});

    [TestMethod]
    public void EveryAbiDimensionAndTerminatorMustMatch()
    {
        var expected=Abi.ExpectedLayout(); Abi.Verify(index=>expected[index]);
        for(var altered=0;altered<expected.Length;altered++)
        {
            var copy=(uint[])expected.Clone(); copy[altered]^=1;
            Assert.ThrowsExactly<BadImageFormatException>(()=>Abi.Verify(index=>copy[index]));
        }
    }
    [TestMethod]
    public void ConfigurationCopiesTrustAndEncodesStrictUtf8()
    {
        var der=new byte[]{42}; var keys=new[]{new TrustedSigner(der)}; var config=Config("工作站",keys);
        der[0]=99; keys[0]=new TrustedSigner(new byte[]{99});
        var api=new Fake(); using var library=new DeviceBoundLibrary(api);
        var opened=library.OpenEnrollment(config); using var client=opened.Client!;
        Assert.AreEqual(Result.Ok,opened.Outcome.Code); Assert.IsFalse(api.Resumed);
        var options=api.CapturedOptions;
        Assert.AreEqual("工作站",Configuration.Utf8.GetString(new ReadOnlySpan<byte>(options.DeviceLabel,9)));
        var key=(Abi.TrustKey*)options.TrustKeys;
        Assert.AreEqual((uint)1,key[0].Size); Assert.AreEqual((byte)42,key[0].Spki[0]);
        Assert.AreEqual((uint)0,options.Reserved);
        Assert.ThrowsExactly<ArgumentException>(()=>Config("a\0b"));
        Assert.ThrowsExactly<System.Text.EncoderFallbackException>(()=>Config("\ud800"));
        Assert.ThrowsExactly<ArgumentException>(()=>Config(new string('a',321)));
        Assert.ThrowsExactly<ArgumentException>(()=>Config(keys:Array.Empty<TrustedSigner>()));
    }
    [TestMethod]
    public void AllCallsPreserveTypedIndependentOutcomesAndComparison()
    {
        var api=new Fake(); using var library=new DeviceBoundLibrary(api);
        using var client=library.OpenResume(Config()).Client!; Assert.IsTrue(api.Resumed);
        api.Next=Result.ProviderError; api.Provider=ProviderResult.SignFailed; api.Checkpoint=CheckpointResult.CommitUnknown;
        foreach(var call in new Func<Outcome>[] {client.Activate,client.Renew,client.Authorize,client.SaveCheckpoint,client.AbandonPending})
        {
            var outcome=call(); Assert.AreEqual(Result.ProviderError,outcome.Code);
            Assert.AreEqual(ProviderResult.SignFailed,outcome.ProviderResult); Assert.AreEqual(CheckpointResult.CommitUnknown,outcome.CheckpointResult);
        }
        Assert.AreEqual(5,api.Invocations);
        api.Next=Result.Ok;
        var view=client.Prepare(); Assert.AreEqual("ABCD-0123-EF45",view.View!.ComparisonCode);
        Assert.AreEqual((ulong)1000,view.View.ExpiresAt);
        Assert.AreEqual(Result.Ok,client.Launch()); Assert.AreEqual(Result.Ok,client.Poll(1000)); Assert.AreEqual(Result.Ok,client.Cancel());
        Assert.ThrowsExactly<ArgumentOutOfRangeException>(()=>client.Poll(1001));
        api.BadComparison=true; Assert.ThrowsExactly<InvalidDataException>(()=>client.Prepare());
    }
    [TestMethod]
    public void MalformedNativeOutcomesNeverBecomePermission()
    {
        var api=new Fake(); using var library=new DeviceBoundLibrary(api); using var client=library.OpenResume(Config()).Client!;
        foreach(var malformed in new[]{1,2,3,4,5,6,7})
        {
            api.Malformed=malformed; Assert.ThrowsExactly<InvalidDataException>(()=>client.Authorize());
        }
        api.Malformed=0; api.Next=(Result)99; Assert.ThrowsExactly<InvalidDataException>(()=>client.Authorize());
        api.Next=Result.Ok; Assert.AreEqual(Result.Ok,client.Authorize().Code);
    }
    [TestMethod]
    public void LibraryDisposalLeavesExistingClientPinnedAndCloseIsExactlyOnce()
    {
        var api=new Fake(); var library=new DeviceBoundLibrary(api); var client=library.OpenResume(Config()).Client!;
        Assert.AreEqual(1,api.Pins); library.Dispose(); library.Dispose(); Assert.AreEqual(1,api.Disposals);
        Assert.ThrowsExactly<ObjectDisposedException>(()=>library.OpenResume(Config()));
        Assert.AreEqual(Result.Ok,client.Authorize().Code);
        client.Dispose(); client.Dispose(); Assert.AreEqual(1,api.Closes); Assert.AreEqual(0,api.Pins);
        Assert.ThrowsExactly<ObjectDisposedException>(()=>client.Authorize());
    }
    [TestMethod]
    public void InvalidOpenCleansReturnedHandleAndDoesNotLeakPins()
    {
        foreach(var mode in new[]{1,2,3,4,6})
        {
            var api=new Fake { OpenMode=mode }; using var library=new DeviceBoundLibrary(api);
            Assert.ThrowsExactly<InvalidDataException>(()=>library.OpenEnrollment(Config()));
            Assert.AreEqual(mode==2?0:1,api.Closes); Assert.AreEqual(0,api.Pins);
        }
        var failed=new Fake { OpenMode=5 }; using var second=new DeviceBoundLibrary(failed);
        var result=second.OpenEnrollment(Config()); Assert.IsNull(result.Client); Assert.AreEqual(Result.InvalidArgument,result.Outcome.Code);
    }
    [TestMethod]
    public void CompetingCallsAreBusyAndDisposeWaitsForNativeReturn()
    {
        var api=new Fake { Block=true }; using var library=new DeviceBoundLibrary(api); var client=library.OpenResume(Config()).Client!;
        var renewal=Task.Run(()=>client.Renew());
        try
        {
            Assert.IsTrue(api.Entered.Wait(TimeSpan.FromSeconds(5)));
            library.Dispose(); GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
            Assert.AreEqual(1,api.Pins); Assert.AreEqual(0,api.Closes);
            Assert.AreEqual(Result.Busy,client.Authorize().Code); Assert.AreEqual(Result.Busy,client.Cancel());
            var closing=Task.Run(()=>client.Dispose());
            Assert.IsFalse(closing.Wait(100)); Assert.AreEqual(0,api.Closes);
            api.Release.Set(); Assert.IsTrue(Task.WaitAll(new Task[]{renewal,closing},5000));
            Assert.AreEqual(Result.Ok,renewal.Result.Code); Assert.AreEqual(1,api.Closes);
        }
        finally { api.Release.Set(); renewal.Wait(5000); client.Dispose(); }
    }
    [TestMethod]
    public void ForgottenClientFinalizerReleasesHandleAndLibraryPin()
    {
        var api=new Fake(); var weak=Forget(api);
        for(var attempt=0;attempt<3;attempt++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
        Assert.IsFalse(weak.IsAlive); Assert.AreEqual(1,api.Closes); Assert.AreEqual(0,api.Pins);
    }
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference Forget(Fake api)
    {
        using var library=new DeviceBoundLibrary(api); return new WeakReference(library.OpenResume(Config()).Client!);
    }
    [TestMethod]
    public void InstalledBridgeMatchesAbiAndRejectsInvalidConfigurationWithoutProvisioning()
    {
        var path=Environment.GetEnvironmentVariable("LCC_TEST_DEVICE_BOUND_DLL");
        if(string.IsNullOrEmpty(path)) { Assert.Inconclusive("Set LCC_TEST_DEVICE_BOUND_DLL to require installed Windows bridge validation."); return; }
        using(var library=new DeviceBoundLibrary(path))
        {
            var result=library.OpenEnrollment(Config(project:""));
            Assert.AreEqual(Result.InvalidArgument,result.Outcome.Code); Assert.IsNull(result.Client);
        }
        var native=new NativeApi(path); using(var pin=native.Pin())
        {
            native.Dispose(); Assert.AreEqual((uint)sizeof(Abi.Options),native.Options().Size);
        }
        if(OperatingSystem.IsWindows() && RuntimeInformation.ProcessArchitecture==Architecture.X64)
            Assert.ThrowsExactly<ArgumentException>(()=>new DeviceBoundLibrary("relative.dll"));
    }
    [TestMethod]
    public void LoadingNonElfFileOnLinuxThrowsDllNotFoundExceptionUnwrapped()
    {
        if(!OperatingSystem.IsLinux()) { Assert.Inconclusive("Linux-only: dlopen rejection of a non-ELF file."); return; }
        var path=Path.GetTempFileName();
        try
        {
            File.WriteAllText(path,"not an ELF binary, just text");
            var error=Assert.ThrowsExactly<DllNotFoundException>(()=>new NativeApi(path));
            Assert.IsTrue(error.Message.Contains(path),$"Expected the real dlerror() text (naming '{path}'), got: \"{error.Message}\"");
        }
        finally { File.Delete(path); }
    }
    [TestMethod]
    public void LoadingViaDlopenPreservesNonAsciiPathBytesExactly()
    {
        if(!OperatingSystem.IsLinux()) { Assert.Inconclusive("Linux-only: dlopen path marshaling for non-ASCII paths."); return; }
        var directory=Path.Combine(Path.GetTempPath(),"licensecc-é東京-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path=Path.Combine(directory,"é東京.so");
        try
        {
            File.WriteAllText(path,"not an ELF binary, just text");
            // dlopen must receive the exact UTF-8 bytes of the path, not a lossy ANSI/codepage
            // transliteration; a mismatch would report ENOENT (file not found) rather than the
            // real "not an ELF" failure, and the reported path text would be mangled.
            var error=Assert.ThrowsExactly<DllNotFoundException>(()=>new NativeApi(path));
            Assert.IsTrue(error.Message.Contains(path),$"Expected the real dlerror() text (naming the exact Unicode path '{path}'), got: \"{error.Message}\"");
        }
        finally { Directory.Delete(directory,true); }
    }

    private sealed class Pin : IDisposable
    {
        private Fake? api;
        internal Pin(Fake api) { this.api=api; api.Pins++; }
        public void Dispose() { var value=Interlocked.Exchange(ref api,null); if(value is not null)value.Pins--; }
    }
    private sealed class Fake : INativeApi
    {
        internal int Pins,Closes,Disposals,Invocations,Malformed,OpenMode;
        internal bool Resumed,BadComparison,Block;
        internal Result Next=Result.Ok;
        internal ProviderResult Provider=ProviderResult.Ok;
        internal CheckpointResult Checkpoint=CheckpointResult.NotAttempted;
        internal Abi.Options CapturedOptions;
        internal readonly ManualResetEventSlim Entered=new(),Release=new();
        public IDisposable Pin() => new Pin(this);
        public Abi.Options Options() => new(){Size=(uint)sizeof(Abi.Options),Version=1};
        public Abi.Outcome Outcome() => new(){Size=(uint)sizeof(Abi.Outcome),Version=1};
        public Abi.View View() => new(){Size=(uint)sizeof(Abi.View),Version=1};
        public int Open(bool resume,Abi.Options* options,IntPtr* handle,Abi.Outcome* outcome)
        {
            Resumed=resume; CapturedOptions=*options; *handle=OpenMode is 2 or 5?IntPtr.Zero:new IntPtr(42);
            if(OpenMode==3)outcome->Reserved=1;
            if(OpenMode==4)return 99;
            if(OpenMode==6)throw new InvalidDataException("Injected native open exception after handle publication.");
            return OpenMode is 1 or 5?(int)Result.InvalidArgument:0;
        }
        public int Invoke(Call call,IntPtr handle,Abi.Outcome* outcome)
        {
            Invocations++; if(Block) { Entered.Set(); if(!Release.Wait(5000))throw new TimeoutException(); }
            outcome->ProviderResult=(uint)Provider; outcome->CheckpointResult=(uint)Checkpoint;
            switch(Malformed)
            {
                case 1:outcome->Size=0;break; case 2:outcome->Version=2;break; case 3:outcome->Reserved=1;break;
                case 4:outcome->RenewalDue=2;break; case 5:outcome->ProviderResult=99;break;
                case 6:outcome->CheckpointResult=99;break; case 7:outcome->ProviderResult=uint.MaxValue;break;
            }
            return (int)Next;
        }
        public int Prepare(IntPtr handle,Abi.View* view)
        {
            Configuration.Utf8.GetBytes(BadComparison?"abcd-0123-EF45":"ABCD-0123-EF45",new Span<byte>(view->ComparisonCode,15));
            view->ExpiresAt=1000; return (int)Next;
        }
        public int Launch(IntPtr handle) => (int)Next;
        public int Poll(IntPtr handle,uint wait) => (int)Next;
        public int Cancel(IntPtr handle) => (int)Next;
        public void Close(IntPtr handle) { Assert.IsTrue(Pins>0); Closes++; }
        public void Dispose() { Disposals++; }
    }
}
