using System;
using System.Runtime.InteropServices;

namespace Licensecc.Client.DeviceBound;

internal static unsafe class FeatureAbi
{
    [StructLayout(LayoutKind.Sequential)] internal struct Outcome
    {
        public uint Size, Version, State, ProviderResult, CheckpointResult, RenewalDue;
        public fixed uint Reserved[2];
        public ulong EffectiveTime, RenewAfter, ExpiresAt;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Alignment { public byte Prefix; public Outcome Value; }
    internal static uint[] ExpectedLayout() => new uint[] {
        1,(uint)IntPtr.Size,(uint)sizeof(Outcome),(uint)Marshal.OffsetOf<Alignment>("Value"),
        (uint)Marshal.OffsetOf<Outcome>("Size"),4,(uint)Marshal.OffsetOf<Outcome>("Version"),4,
        (uint)Marshal.OffsetOf<Outcome>("State"),4,(uint)Marshal.OffsetOf<Outcome>("ProviderResult"),4,
        (uint)Marshal.OffsetOf<Outcome>("CheckpointResult"),4,(uint)Marshal.OffsetOf<Outcome>("RenewalDue"),4,
        (uint)Marshal.OffsetOf<Outcome>("Reserved"),8,(uint)Marshal.OffsetOf<Outcome>("EffectiveTime"),8,
        (uint)Marshal.OffsetOf<Outcome>("RenewAfter"),8,(uint)Marshal.OffsetOf<Outcome>("ExpiresAt"),8,uint.MaxValue
    };
    internal static void Verify(Func<uint,uint> probe)
    {
        var expected=ExpectedLayout();
        for(uint i=0;i<expected.Length;i++)
            if(probe(i)!=expected[i]) throw new BadImageFormatException("Incompatible feature-session bridge ABI.");
    }
}
internal enum FeatureCall { Start, Renew, Stop, SaveCheckpoint }
internal unsafe interface IFeatureApi : IDisposable
{
    IDisposable Pin();
    Abi.Options Options();
    FeatureAbi.Outcome Outcome();
    int Open(Abi.Options* options,IntPtr* handle,FeatureAbi.Outcome* outcome);
    int Invoke(FeatureCall call,IntPtr handle,FeatureAbi.Outcome* outcome);
    int Authorize(IntPtr handle,byte* feature,FeatureAbi.Outcome* outcome);
    void Close(IntPtr handle);
}
internal sealed unsafe partial class NativeApi
{
    internal IFeatureApi Features() => new FeatureApi(this);
    private sealed class FeatureApi : IFeatureApi
    {
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void Init(FeatureAbi.Outcome* outcome);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int OpenFeature(Abi.Options* options,IntPtr* handle,FeatureAbi.Outcome* outcome);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int Operation(IntPtr handle,FeatureAbi.Outcome* outcome);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int Check(IntPtr handle,byte* feature,FeatureAbi.Outcome* outcome);
        private readonly NativeApi owner;
        private readonly Init initialize;
        private readonly OpenFeature open;
        private readonly Operation[] operations;
        private readonly Check authorize;
        private readonly CloseCall close;
        internal FeatureApi(NativeApi owner)
        {
            this.owner=owner;
            using var pin=owner.Pin();
            T Export<T>(string name) where T : Delegate => Marshal.GetDelegateForFunctionPointer<T>(NativeLibrary.GetExport(owner.module.DangerousGetHandle(),name));
            try
            {
                var probe=Export<Probe>("lcc_feature_session_bridge_layout"); FeatureAbi.Verify(i=>probe(i));
                initialize=Export<Init>("lcc_init_feature_session_outcome");
                open=Export<OpenFeature>("lcc_feature_session_open");
                authorize=Export<Check>("lcc_feature_session_authorize");
                close=Export<CloseCall>("lcc_feature_session_close");
                operations=new[] { Export<Operation>("lcc_feature_session_start"),Export<Operation>("lcc_feature_session_renew"),
                    Export<Operation>("lcc_feature_session_stop"),Export<Operation>("lcc_feature_session_save_checkpoint") };
            }
            catch(EntryPointNotFoundException error) { throw new NotSupportedException("This native bridge does not support feature sessions.",error); }
        }
        public IDisposable Pin() => owner.Pin();
        public Abi.Options Options() => owner.Options();
        public FeatureAbi.Outcome Outcome() { FeatureAbi.Outcome value=default; initialize(&value); return value; }
        public int Open(Abi.Options* options,IntPtr* handle,FeatureAbi.Outcome* outcome) => open(options,handle,outcome);
        public int Invoke(FeatureCall call,IntPtr handle,FeatureAbi.Outcome* outcome) => operations[(int)call](handle,outcome);
        public int Authorize(IntPtr handle,byte* feature,FeatureAbi.Outcome* outcome) => authorize(handle,feature,outcome);
        public void Close(IntPtr handle) => close(handle);
        public void Dispose() => owner.Dispose();
    }
}
