using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Windows converts each render endpoint's mix to 16 kHz mono float PCM before it enters stdout.
class Loopback
{
    static volatile bool running = true;
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();

    [MTAThread]
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 1 && args[0] == "--list")
                Console.WriteLine(json.Serialize(Devices()));
            else if (args.Length == 2 && args[0] == "--capture")
                Capture(args[1]);
            else throw new ArgumentException("Expected --list or --capture <render endpoint ID>");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }

    static List<Dictionary<string, string>> Devices()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDeviceCollection devices;
        Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(0, 1, out devices)); // eRender, DEVICE_STATE_ACTIVE
        var result = new List<Dictionary<string, string>>();
        try
        {
            uint count;
            Marshal.ThrowExceptionForHR(devices.GetCount(out count));
            for (uint i = 0; i < count; i++)
            {
                IMMDevice device;
                Marshal.ThrowExceptionForHR(devices.Item(i, out device));
                IPropertyStore store = null;
                try
                {
                    string id;
                    Marshal.ThrowExceptionForHR(device.GetId(out id));
                    Marshal.ThrowExceptionForHR(device.OpenPropertyStore(0, out store));
                    var key = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
                    PropVariant value;
                    Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
                    string label;
                    try { label = Marshal.PtrToStringUni(value.pointer) ?? id; }
                    finally { PropVariantClear(ref value); }
                    result.Add(new Dictionary<string, string> { { "id", id }, { "label", label } });
                }
                finally
                {
                    if (store != null) Marshal.ReleaseComObject(store);
                    Marshal.ReleaseComObject(device);
                }
            }
        }
        finally { Marshal.ReleaseComObject(devices); Marshal.ReleaseComObject(enumerator); }
        return result;
    }

    static void Capture(string id)
    {
        if (!Devices().Exists(d => d["id"] == id)) throw new ArgumentException("Playback device is unavailable");
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDevice(id, out device));
        object raw;
        var iid = typeof(IAudioClient).GUID;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out raw));
        var client = (IAudioClient)raw;
        IAudioCaptureClient capture = null;
        bool started = false;
        try
        {
            var format = new WaveFormat { tag = 3, channels = 1, rate = 16000, bytesPerSecond = 64000, blockAlign = 4, bits = 32 };
            Marshal.ThrowExceptionForHR(client.Initialize(0, 0x88020000, 1000000, 0, ref format, IntPtr.Zero));
            iid = typeof(IAudioCaptureClient).GUID;
            Marshal.ThrowExceptionForHR(client.GetService(ref iid, out raw));
            capture = (IAudioCaptureClient)raw;
            Marshal.ThrowExceptionForHR(client.Start());
            started = true;
            Console.Error.WriteLine("READY");
            var stdin = new Thread(() => { Console.In.ReadLine(); running = false; });
            stdin.IsBackground = true;
            stdin.Start();
            var clock = System.Diagnostics.Stopwatch.StartNew();
            long lastPacket = 0;
            var silence = new byte[1280];
            using (var output = Console.OpenStandardOutput())
            {
                while (running)
                {
                    uint pending;
                    Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out pending));
                    if (pending == 0)
                    {
                        // Keep VAD progressing when a stopped player produces no loopback packets.
                        if (clock.ElapsedMilliseconds - lastPacket >= 20)
                        {
                            output.Write(silence, 0, silence.Length);
                            lastPacket = clock.ElapsedMilliseconds;
                        }
                        Thread.Sleep(5);
                        continue;
                    }
                    IntPtr data;
                    uint frames, flags;
                    ulong position, timestamp;
                    Marshal.ThrowExceptionForHR(capture.GetBuffer(out data, out frames, out flags, out position, out timestamp));
                    try
                    {
                        var bytes = new byte[checked((int)frames * 4)];
                        if ((flags & 2) == 0) Marshal.Copy(data, bytes, 0, bytes.Length);
                        output.Write(bytes, 0, bytes.Length);
                        lastPacket = clock.ElapsedMilliseconds;
                    }
                    finally { Marshal.ThrowExceptionForHR(capture.ReleaseBuffer(frames)); }
                }
            }
        }
        finally
        {
            if (started) client.Stop();
            if (capture != null) Marshal.ReleaseComObject(capture);
            Marshal.ReleaseComObject(client);
            Marshal.ReleaseComObject(device);
            Marshal.ReleaseComObject(enumerator);
        }
    }

    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
    [StructLayout(LayoutKind.Sequential, Pack = 2)] struct WaveFormat
    {
        public ushort tag, channels;
        public uint rate, bytesPerSecond;
        public ushort blockAlign, bits, extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant
    {
        [FieldOffset(0)] public ushort type;
        [FieldOffset(8)] public IntPtr pointer;
    }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint states, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object value);
        [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    }
    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioClient
    {
        [PreserveSig] int Initialize(int mode, uint flags, long duration, long period, ref WaveFormat format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    }
    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong timestamp);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }
}
