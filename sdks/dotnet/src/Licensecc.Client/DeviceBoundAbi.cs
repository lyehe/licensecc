using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace Licensecc.Client.DeviceBound;

// Blittable storage mirrors the public C header; never use platform ANSI strings.
internal static unsafe class Abi
{
    [StructLayout(LayoutKind.Sequential)] internal struct TrustKey
    { public uint Size, Retired; public fixed byte Spki[512]; }
    [StructLayout(LayoutKind.Sequential)] internal struct Options
    {
        public uint Size, Version, TrustKeyCount, Reserved;
        public fixed byte ApplicationId[129], EndpointOrigin[1025], PortalUrl[1025], Issuer[1025], LeaseAudience[1025], ProofAudience[1025];
        public fixed byte Project[128], Feature[16], ClientId[128], DeviceLabel[321], CallbackPath[256];
        // uint storage supplies the C trust-array's four-byte alignment.
        public fixed uint TrustKeys[1040];
    }
    [StructLayout(LayoutKind.Sequential)] internal struct View
    { public uint Size, Version; public ulong ExpiresAt; public fixed byte ComparisonCode[15]; }
    [StructLayout(LayoutKind.Sequential)] internal struct Outcome
    { public uint Size, Version, ProviderResult, CheckpointResult, RenewalDue, Reserved; public ulong EffectiveTime; }
    [StructLayout(LayoutKind.Sequential)] private struct TrustAlignment { public byte Prefix; public TrustKey Value; }
    [StructLayout(LayoutKind.Sequential)] private struct OptionsAlignment { public byte Prefix; public Options Value; }
    [StructLayout(LayoutKind.Sequential)] private struct ViewAlignment { public byte Prefix; public View Value; }
    [StructLayout(LayoutKind.Sequential)] private struct OutcomeAlignment { public byte Prefix; public Outcome Value; }

    internal static uint[] ExpectedLayout()
    {
        var result = new List<uint> { 1, (uint)IntPtr.Size, 1, 8, 512 };
        Add<TrustKey, TrustAlignment>(result); Add<Options, OptionsAlignment>(result);
        Add<View, ViewAlignment>(result); Add<Outcome, OutcomeAlignment>(result);
        result.Add(uint.MaxValue); return result.ToArray();
    }
    private static void Add<T, TAlignment>(List<uint> result) where T : struct where TAlignment : struct
    {
        result.Add((uint)Marshal.SizeOf<T>());
        result.Add((uint)Marshal.OffsetOf<TAlignment>("Value").ToInt32());
        var fields = typeof(T).GetFields(BindingFlags.Instance | BindingFlags.Public);
        Array.Sort(fields, (a,b) => a.MetadataToken.CompareTo(b.MetadataToken));
        foreach (var field in fields)
        {
            result.Add((uint)Marshal.OffsetOf<T>(field.Name).ToInt32());
            var fixedBuffer = field.GetCustomAttribute<FixedBufferAttribute>();
            result.Add((uint)(fixedBuffer is null ? Marshal.SizeOf(field.FieldType) : fixedBuffer.Length * Marshal.SizeOf(fixedBuffer.ElementType)));
        }
    }
    internal static void Verify(Func<uint,uint> probe)
    {
        var expected = ExpectedLayout();
        for (uint i = 0; i < expected.Length; i++)
            if (probe(i) != expected[i]) throw new BadImageFormatException("Incompatible Licensecc device-bound bridge ABI.");
    }
}
