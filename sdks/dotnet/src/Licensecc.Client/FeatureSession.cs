using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;

namespace Licensecc.Client.DeviceBound;

public enum FeatureSessionState { Unknown=0, Ready=1, Starting=2, Active=3, NeedsOnline=4, Denied=5, Failed=6, Stopped=7 }
/// <summary>State and deadlines are advisory; only Authorize Ok permits the next protected unit.</summary>
public sealed record FeatureSessionOutcome(Result Code,FeatureSessionState State=FeatureSessionState.Unknown,
    ProviderResult ProviderResult=ProviderResult.Ok,CheckpointResult CheckpointResult=CheckpointResult.NotAttempted,
    bool RenewalDue=false,ulong EffectiveTime=0,ulong RenewAfter=0,ulong ExpiresAt=0);

/// <summary>Optional native session API. Old native bridges remain usable with DeviceBoundLibrary.</summary>
public sealed unsafe class FeatureSessionLibrary : IDisposable
{
    private readonly IFeatureApi api;
    private readonly object gate=new();
    private bool disposed;
    public FeatureSessionLibrary(string absoluteDllPath)
    {
        var native=new NativeApi(absoluteDllPath);
        try { api=native.Features(); } catch { native.Dispose(); throw; }
    }
    internal FeatureSessionLibrary(IFeatureApi api) { this.api=api; }
    public (FeatureSession? Session,FeatureSessionOutcome Outcome) Open(Configuration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        lock(gate)
        {
            ObjectDisposedException.ThrowIf(disposed,this);
            using var pin=api.Pin();
            var options=configuration.Encode(api.Options()); var raw=api.Outcome(); IntPtr handle=IntPtr.Zero;
            try
            {
                var result=FeatureSession.Decode(api.Open(&options,&handle,&raw),raw);
                if(result.Code!=Result.Ok)
                {
                    if(handle!=IntPtr.Zero) throw new InvalidDataException("Failed native open returned a handle.");
                    return (null,result);
                }
                if(handle==IntPtr.Zero) throw new InvalidDataException("Successful native open returned no handle.");
                var owner=new FeatureHandle(api,handle); handle=IntPtr.Zero;
                try { return (new FeatureSession(api,owner),result); } catch { owner.Dispose(); throw; }
            }
            finally { if(handle!=IntPtr.Zero) api.Close(handle); }
        }
    }
    public void Dispose() { lock(gate) { if(disposed)return; disposed=true; api.Dispose(); } }
}
internal sealed class FeatureHandle : SafeHandle
{
    private readonly IFeatureApi api;
    private readonly IDisposable pin;
    internal FeatureHandle(IFeatureApi api,IntPtr value) : base(IntPtr.Zero,true)
    { this.api=api; pin=api.Pin(); SetHandle(value); }
    public override bool IsInvalid => handle==IntPtr.Zero;
    protected override bool ReleaseHandle() { try { api.Close(handle); return true; } finally { pin.Dispose(); } }
}
/// <summary>One immutable feature and one job. Blocking calls belong on an application worker thread.</summary>
public sealed unsafe class FeatureSession : IDisposable
{
    private readonly IFeatureApi api;
    private readonly FeatureHandle handle;
    private readonly object gate=new();
    private bool disposed;
    internal FeatureSession(IFeatureApi api,FeatureHandle handle) { this.api=api; this.handle=handle; }
    public FeatureSessionOutcome Start() => Invoke(FeatureCall.Start);
    public FeatureSessionOutcome Renew() => Invoke(FeatureCall.Renew);
    public FeatureSessionOutcome Stop() => Invoke(FeatureCall.Stop);
    public FeatureSessionOutcome SaveCheckpoint() => Invoke(FeatureCall.SaveCheckpoint);
    private FeatureSessionOutcome Invoke(FeatureCall call)
    {
        if(!Monitor.TryEnter(gate)) return new FeatureSessionOutcome(Result.Busy);
        try
        {
            ObjectDisposedException.ThrowIf(disposed,this);
            var raw=api.Outcome(); return Decode(api.Invoke(call,handle.DangerousGetHandle(),&raw),raw);
        }
        finally { GC.KeepAlive(handle); Monitor.Exit(gate); }
    }
    public FeatureSessionOutcome Authorize(string requiredFeature)
    {
        if(requiredFeature is null || !Regex.IsMatch(requiredFeature,"\\A[A-Za-z0-9_.:-]{1,15}\\z"))
            throw new ArgumentException("Expected a 1..15-character feature ID.",nameof(requiredFeature));
        if(!Monitor.TryEnter(gate)) return new FeatureSessionOutcome(Result.Busy);
        try
        {
            ObjectDisposedException.ThrowIf(disposed,this);
            var feature=Configuration.Utf8.GetBytes(requiredFeature+"\0"); var raw=api.Outcome();
            fixed(byte* pointer=feature) return Decode(api.Authorize(handle.DangerousGetHandle(),pointer,&raw),raw);
        }
        finally { GC.KeepAlive(handle); Monitor.Exit(gate); }
    }
    internal static FeatureSessionOutcome Decode(int code,FeatureAbi.Outcome raw)
    {
        if(raw.Size!=sizeof(FeatureAbi.Outcome) || raw.Version!=1 || raw.Reserved[0]!=0 || raw.Reserved[1]!=0 || raw.RenewalDue>1 ||
            !Enum.IsDefined(typeof(FeatureSessionState),(int)raw.State) || !Enum.IsDefined(typeof(ProviderResult),(int)raw.ProviderResult) ||
            !Enum.IsDefined(typeof(CheckpointResult),(int)raw.CheckpointResult)) throw new InvalidDataException("Invalid native feature-session outcome.");
        return new FeatureSessionOutcome(DeviceBoundClient.DecodeCode(code),(FeatureSessionState)raw.State,(ProviderResult)raw.ProviderResult,
            (CheckpointResult)raw.CheckpointResult,raw.RenewalDue==1,raw.EffectiveTime,raw.RenewAfter,raw.ExpiresAt);
    }
    /// <summary>Wait for admitted calls, then close once. Explicitly recover pending persistence before disposal.</summary>
    public void Dispose() { lock(gate) { if(disposed)return; disposed=true; handle.Dispose(); } }
}
