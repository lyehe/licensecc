using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Licensecc.Client.DeviceBound;

public enum Result
{
    Ok=0, InvalidArgument=1, UnsupportedVersion=2, UnsupportedPlatform=3, Busy=4, InvalidState=5,
    Retry=6, Conflict=7, Denied=8, Expired=9, Waiting=10, CallbackRejected=11, CallbackReceived=12,
    EnrollmentRequired=13, OnlineRequired=14, ResumeRequired=15, InvalidResponse=16,
    ProviderError=17, StorageError=18, BrowserUnavailable=19, Cancelled=20, InternalError=255
}
public enum CheckpointResult
{ NotAttempted=0, Saved=1, Unchanged=2, Missing=3, Busy=4, Stale=5, Conflict=6, Invalid=7, IoError=8, MirrorPending=9, CommitUnknown=10, Loaded=11 }
public enum ProviderResult
{ Ok=0, InvalidArgument=1, UnsupportedVersion=2, BufferTooSmall=3, ProviderUnavailable=4, HardwareUnavailable=5, AccessDenied=6, KeyNotFound=7, KeyCorrupt=8, KeyLost=9, UnsupportedAlgorithm=10, SignFailed=11, IoError=12, Busy=13, PolicyViolation=14, InternalError=255 }

/// <summary>Independent native outcomes. Only Authorize returning Ok permits protected work.</summary>
public sealed record Outcome(Result Code, ProviderResult ProviderResult=ProviderResult.Ok,
    CheckpointResult CheckpointResult=CheckpointResult.NotAttempted, bool RenewalDue=false, ulong EffectiveTime=0);
/// <summary>Comparison display only; ExpiresAt is not a local authorization clock.</summary>
public sealed record EnrollmentView(string ComparisonCode, ulong ExpiresAt);

/// <summary>Immutable copy of a developer-supplied public RSA-3072 DER SPKI.</summary>
public sealed class TrustedSigner
{
    private readonly byte[] spki;
    public bool Retired { get; }
    public TrustedSigner(ReadOnlySpan<byte> spkiDer, bool retired=false)
    {
        if (spkiDer.Length is < 1 or > 512) throw new ArgumentException("SPKI must contain 1..512 bytes.",nameof(spkiDer));
        spki=spkiDer.ToArray(); Retired=retired;
    }
    internal void CopyTo(Span<byte> target) => spki.CopyTo(target);
    internal uint Size => (uint)spki.Length;
}

/// <summary>Immutable application configuration. Native validation remains authoritative.</summary>
public sealed class Configuration
{
    private readonly string[] values;
    private readonly TrustedSigner[] trust;
    private static readonly int[] Capacities = {129,1025,1025,1025,1025,1025,128,16,128,321,256};
    internal static readonly UTF8Encoding Utf8 = new(false,true);
    public Configuration(string applicationId,string endpointOrigin,string portalAuthorizationUrl,string issuer,
        string leaseAudience,string proofAudience,string project,string feature,string clientId,string deviceLabel,
        IEnumerable<TrustedSigner> trustKeys,string callbackPath="/callback")
    {
        values=new[]{applicationId,endpointOrigin,portalAuthorizationUrl,issuer,leaseAudience,proofAudience,project,feature,clientId,deviceLabel,callbackPath};
        for(var i=0;i<values.Length;i++)
            if(values[i] is null || values[i].Contains('\0') || Utf8.GetByteCount(values[i]) >= Capacities[i])
                throw new ArgumentException("Configuration text must fit its NUL-terminated UTF-8 field.");
        ArgumentNullException.ThrowIfNull(trustKeys);
        trust=trustKeys.ToArray();
        if(trust.Length is < 1 or > 8 || trust.Any(key=>key is null)) throw new ArgumentException("Expected 1..8 trusted signers.",nameof(trustKeys));
    }
    internal unsafe Abi.Options Encode(Abi.Options options)
    {
        byte*[] destinations={options.ApplicationId,options.EndpointOrigin,options.PortalUrl,options.Issuer,options.LeaseAudience,
            options.ProofAudience,options.Project,options.Feature,options.ClientId,options.DeviceLabel,options.CallbackPath};
        for(var i=0;i<values.Length;i++)
        {
            var bytes=new Span<byte>(destinations[i],Capacities[i]); bytes.Clear(); Utf8.GetBytes(values[i],bytes);
        }
        options.TrustKeyCount=(uint)trust.Length;
        var keys=(Abi.TrustKey*)options.TrustKeys;
        for(var i=0;i<trust.Length;i++)
        {
            keys[i]=default; keys[i].Size=trust[i].Size; keys[i].Retired=trust[i].Retired?1u:0u;
            trust[i].CopyTo(new Span<byte>(keys[i].Spki,512));
        }
        return options;
    }
}
