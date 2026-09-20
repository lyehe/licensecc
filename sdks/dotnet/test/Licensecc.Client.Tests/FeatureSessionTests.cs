using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Licensecc.Client.DeviceBound;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Licensecc.Client.Tests;

[TestClass]
public unsafe class FeatureSessionTests
{
    private static Configuration Config() => new("feature-test","https://license.example.test","https://portal.example.test/connect",
        "issuer","desktop","desktop","APP","BATCH_RUN","desktop","Test",new[]{new TrustedSigner(new byte[]{42})});
    private sealed class Pin : IDisposable { public void Dispose() { } }
    private sealed class Fake : IFeatureApi
    {
        public readonly List<IntPtr> Closed=new();
        public readonly List<FeatureCall> Calls=new();
        public string? Feature;
        public Result Next=Result.Ok;
        public CheckpointResult Checkpoint=CheckpointResult.CommitUnknown;
        private int next=1;
        public IDisposable Pin()=>new Pin();
        public void Dispose() { }
        public Abi.Options Options()=>new(){Size=(uint)sizeof(Abi.Options),Version=1};
        public FeatureAbi.Outcome Outcome()=>new(){Size=(uint)sizeof(FeatureAbi.Outcome),Version=1};
        public int Open(Abi.Options* options,IntPtr* handle,FeatureAbi.Outcome* result)
        { *handle=new IntPtr(next++); result->State=(uint)FeatureSessionState.Ready; return (int)Result.Ok; }
        public int Invoke(FeatureCall call,IntPtr handle,FeatureAbi.Outcome* result)
        { Calls.Add(call); result->State=(uint)FeatureSessionState.Active; result->CheckpointResult=(uint)Checkpoint; return (int)Next; }
        public int Authorize(IntPtr handle,byte* feature,FeatureAbi.Outcome* result)
        {
            Feature=Marshal.PtrToStringUTF8((IntPtr)feature); result->State=(uint)FeatureSessionState.Active;
            result->EffectiveTime=1000; result->RenewAfter=1450; result->ExpiresAt=1900; return (int)Next;
        }
        public void Close(IntPtr handle)=>Closed.Add(handle);
    }
    [TestMethod]
    public void SeparateOwnersForwardFeaturesAndNativeOutcomesWithoutCaching()
    {
        var api=new Fake(); using var library=new FeatureSessionLibrary(api);
        for(var i=0;i<2;i++)
        {
            var opened=library.Open(Config()); Assert.AreEqual(FeatureSessionState.Ready,opened.Outcome.State);
            using var session=opened.Session!;
            Assert.AreEqual(CheckpointResult.CommitUnknown,session.Start().CheckpointResult);
            foreach(var code in new[]{Result.Ok,Result.Retry,Result.Denied,Result.OnlineRequired,Result.Cancelled})
            {
                api.Next=code; var checkedResult=session.Authorize("BATCH_RUN");
                Assert.AreEqual(code,checkedResult.Code); Assert.AreEqual("BATCH_RUN",api.Feature);
                Assert.AreEqual(1900UL,checkedResult.ExpiresAt);
            }
            session.Stop(); session.Dispose();
        }
        CollectionAssert.AreEqual(new[]{new IntPtr(1),new IntPtr(2)},api.Closed);
        CollectionAssert.AreEqual(new[]{FeatureCall.Start,FeatureCall.Stop,FeatureCall.Start,FeatureCall.Stop},api.Calls);
    }
    [TestMethod]
    public void InvalidFeatureAndClosedOwnerDoNotReachNativeCalls()
    {
        var api=new Fake(); using var library=new FeatureSessionLibrary(api);
        var session=library.Open(Config()).Session!;
        foreach(var value in new[]{"",new string('x',16),"x\0y","é"})
            Assert.ThrowsException<ArgumentException>(()=>session.Authorize(value));
        Assert.AreEqual(Result.Ok,session.Authorize("A.b:c-d_e").Code);
        session.Dispose(); Assert.ThrowsException<ObjectDisposedException>(()=>session.Start());
        Assert.AreEqual(1,api.Closed.Count);
    }
    [TestMethod]
    public void OutcomeLayoutAndUnknownValuesAreRejected()
    {
        var values=FeatureAbi.ExpectedLayout(); Assert.AreEqual(56U,values[2]);
        for(var index=0;index<values.Length;index++)
        {
            var changed=index;
            Assert.ThrowsException<BadImageFormatException>(()=>FeatureAbi.Verify(i=>values[i]^(i==changed?1U:0U)));
        }
        var raw=new FeatureAbi.Outcome{Size=56,Version=1,State=99};
        Assert.ThrowsException<InvalidDataException>(()=>FeatureSession.Decode(0,raw));
        raw.State=0;raw=CorruptReserved(raw);
        Assert.ThrowsException<InvalidDataException>(()=>FeatureSession.Decode(0,raw));
    }
    private static FeatureAbi.Outcome CorruptReserved(FeatureAbi.Outcome raw) { raw.Reserved[1]=1; return raw; }
    [TestMethod]
    public void InstalledOptionalBridgeValidatesWithoutProvisioning()
    {
        var path=Environment.GetEnvironmentVariable("LCC_TEST_DEVICE_BOUND_DLL");
        if(string.IsNullOrEmpty(path)) Assert.Inconclusive("Set LCC_TEST_DEVICE_BOUND_DLL to the new installed bridge.");
        using var library=new FeatureSessionLibrary(path!);
        var opened=library.Open(Config()); Assert.IsNull(opened.Session);
        Assert.AreEqual(Result.InvalidArgument,opened.Outcome.Code);
    }
    [TestMethod]
    public void OriginalExportsRejectOptionalApiWithoutBreakingDeviceBound()
    {
        var path=Environment.GetEnvironmentVariable("LCC_TEST_OLD_DEVICE_BOUND_DLL");
        if(string.IsNullOrEmpty(path)) Assert.Inconclusive("Set LCC_TEST_OLD_DEVICE_BOUND_DLL to the original-export fixture.");
        Assert.ThrowsException<NotSupportedException>(()=>new FeatureSessionLibrary(path!));
        using var existing=new DeviceBoundLibrary(path!);
        var opened=existing.OpenResume(Config());
        Assert.IsNull(opened.Client); Assert.AreEqual(Result.InvalidArgument,opened.Outcome.Code);
    }
}
