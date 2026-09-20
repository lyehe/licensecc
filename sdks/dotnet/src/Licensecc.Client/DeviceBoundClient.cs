using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;

namespace Licensecc.Client.DeviceBound;

/// <summary>Loads the application-owned bridge. Disposing it prevents new opens; existing clients retain their library pin.</summary>
public sealed unsafe class DeviceBoundLibrary : IDisposable
{
    private readonly INativeApi api;
    private readonly object gate=new();
    private bool disposed;
    public DeviceBoundLibrary(string absoluteDllPath) : this(new NativeApi(absoluteDllPath)) { }
    internal DeviceBoundLibrary(INativeApi api) { this.api=api; }
    public (DeviceBoundClient? Client,Outcome Outcome) OpenEnrollment(Configuration configuration) => Open(configuration,false);
    public (DeviceBoundClient? Client,Outcome Outcome) OpenResume(Configuration configuration) => Open(configuration,true);
    private (DeviceBoundClient?,Outcome) Open(Configuration configuration,bool resume)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        lock(gate)
        {
            ObjectDisposedException.ThrowIf(disposed,this);
            using var pin=api.Pin();
            var options=configuration.Encode(api.Options()); var raw=api.Outcome(); IntPtr handle=IntPtr.Zero;
            try
            {
                var result=DeviceBoundClient.Decode(api.Open(resume,&options,&handle,&raw),raw);
                if(result.Code!=Result.Ok)
                {
                    if(handle!=IntPtr.Zero) throw new InvalidDataException("Failed native open returned a handle.");
                    return (null,result);
                }
                if(handle==IntPtr.Zero) throw new InvalidDataException("Successful native open returned no handle.");
                var owner=new ClientHandle(api,handle); handle=IntPtr.Zero;
                try { return (new DeviceBoundClient(api,owner),result); }
                catch { owner.Dispose(); throw; }
            }
            finally { if(handle!=IntPtr.Zero) api.Close(handle); }
        }
    }
    public void Dispose() { lock(gate) { if(disposed)return; disposed=true; api.Dispose(); } }
}

internal sealed class ClientHandle : SafeHandle
{
    private readonly INativeApi api;
    private readonly IDisposable pin;
    internal ClientHandle(INativeApi api,IntPtr handle) : base(IntPtr.Zero,true)
    { this.api=api; pin=api.Pin(); SetHandle(handle); }
    public override bool IsInvalid => handle==IntPtr.Zero;
    protected override bool ReleaseHandle()
    {
        try { api.Close(handle); return true; }
        finally { pin.Dispose(); }
    }
}

/// <summary>Opaque native owner. Calls are blocking; use an application worker thread. Only Authorize returning Ok permits work.</summary>
public sealed unsafe class DeviceBoundClient : IDisposable
{
    private readonly INativeApi api;
    private readonly ClientHandle handle;
    private readonly object gate=new();
    private bool disposed;
    internal DeviceBoundClient(INativeApi api,ClientHandle handle) { this.api=api; this.handle=handle; }
    public Outcome Activate() => Invoke(Call.Activate);
    public Outcome Renew() => Invoke(Call.Renew);
    public Outcome Authorize() => Invoke(Call.Authorize);
    public Outcome SaveCheckpoint() => Invoke(Call.SaveCheckpoint);
    public Outcome AbandonPending() => Invoke(Call.AbandonPending);
    private Outcome Invoke(Call call)
    {
        if(!Monitor.TryEnter(gate)) return new Outcome(Result.Busy);
        try
        {
            ObjectDisposedException.ThrowIf(disposed,this);
            var raw=api.Outcome();
            return Decode(api.Invoke(call,handle.DangerousGetHandle(),&raw),raw);
        }
        finally { GC.KeepAlive(handle); Monitor.Exit(gate); }
    }
    public (Result Code,EnrollmentView? View) Prepare()
    {
        if(!Monitor.TryEnter(gate)) return (Result.Busy,null);
        try
        {
            ObjectDisposedException.ThrowIf(disposed,this);
            var raw=api.View(); var code=DecodeCode(api.Prepare(handle.DangerousGetHandle(),&raw));
            if(code!=Result.Ok) return (code,null);
            if(raw.Size!=sizeof(Abi.View) || raw.Version!=1 || raw.ComparisonCode[14]!=0)
                throw new InvalidDataException("Invalid native comparison layout.");
            var comparison=Configuration.Utf8.GetString(new ReadOnlySpan<byte>(raw.ComparisonCode,14));
            if(!Regex.IsMatch(comparison,"\\A[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}\\z"))
                throw new InvalidDataException("Invalid native comparison code.");
            return (code,new EnrollmentView(comparison,raw.ExpiresAt));
        }
        finally { GC.KeepAlive(handle); Monitor.Exit(gate); }
    }
    public Result Launch() => Simple(api.Launch);
    public Result Poll(uint waitMilliseconds=0)
    {
        if(waitMilliseconds>1000) throw new ArgumentOutOfRangeException(nameof(waitMilliseconds));
        return Simple(pointer=>api.Poll(pointer,waitMilliseconds));
    }
    public Result Cancel() => Simple(api.Cancel);
    private Result Simple(Func<IntPtr,int> call)
    {
        if(!Monitor.TryEnter(gate)) return Result.Busy;
        try { ObjectDisposedException.ThrowIf(disposed,this); return DecodeCode(call(handle.DangerousGetHandle())); }
        finally { GC.KeepAlive(handle); Monitor.Exit(gate); }
    }
    internal static Result DecodeCode(int code) => Enum.IsDefined(typeof(Result),code) ? (Result)code : throw new InvalidDataException("Unknown native result.");
    internal static Outcome Decode(int code,Abi.Outcome raw)
    {
        if(raw.Size!=sizeof(Abi.Outcome) || raw.Version!=1 || raw.Reserved!=0 || raw.RenewalDue>1 ||
            !Enum.IsDefined(typeof(ProviderResult),(int)raw.ProviderResult) || !Enum.IsDefined(typeof(CheckpointResult),(int)raw.CheckpointResult))
            throw new InvalidDataException("Invalid native outcome.");
        return new Outcome(DecodeCode(code),(ProviderResult)raw.ProviderResult,(CheckpointResult)raw.CheckpointResult,raw.RenewalDue==1,raw.EffectiveTime);
    }
    /// <summary>Waits for an admitted call, then closes once. Does not save, retire or delete the native identity.</summary>
    public void Dispose() { lock(gate) { if(disposed)return; disposed=true; handle.Dispose(); } }
}
