const fileInput = document.getElementById("file");
const vbrInput = document.getElementById("vbr");
const sampleRateInput = document.getElementById("sr");
const monoInput = document.getElementById("mono");
const btn = document.getElementById("convert");
const statusMark = document.getElementById("status");
const dl = document.getElementById("download");

const offContext = window.OfflineAudioContext || window.AudioContext;

const decode = async file => {
    const arrayBuf = await file.arrayBuffer();
    const ctx = new offContext(1, 1, 44100);

    return await new Promise((resolve, reject) => ctx.decodeAudioData(arrayBuf, resolve, reject));
};

const resampleAndMix = (audioBuffer, targetRate, toMono) => {
    const channels = toMono ? 1 : audioBuffer.numberOfChannels;
    const size = Math.ceil(audioBuffer.duration * targetRate);
    const offline = new offContext(channels, size, targetRate);
    const buf = offline.createBuffer(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) buf.copyToChannel(audioBuffer.getChannelData(c), c);

    const source = offline.createBufferSource();

    source.buffer = buf;
    source.connect(offline.destination);
    source.start();

    return offline.startRendering();
};

const concatChunks = chunks => {
    let total = 0;

    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;

    const out = new Uint8Array(total);
    let offset = 0;

    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];

        out.set(c, offset);
        offset += c.length;
    }

    return out;
};

async function convert() {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
        statusMark.textContent = "Select a file";
        return;
    }

    dl.style.display = "none";
    statusMark.textContent = "Decoding...";

    let audio;
    try {
        audio = await decode(file);
    } catch (e) {
        statusMark.textContent = "Decoding error";
        return;
    }

    const targetSR = Math.max(8000, Math.min(48000, parseInt(sampleRateInput.value) || 44100));
    const toMono = monoInput.checked;

    statusMark.textContent = `Resampling to ${targetSR} Hz${toMono ? ", mono" : ''}...`;

    let resampled;
    try {
        resampled = await resampleAndMix(audio, targetSR, toMono);
    } catch (e) {
        statusMark.textContent = "Resample error";
        return;
    }

    const channels = toMono ? 1 : resampled.numberOfChannels;
    const sampleRate = resampled.sampleRate;

    statusMark.textContent = "Loading encoder...";
    if (!window.WasmMediaEncoder || !WasmMediaEncoder.createOggEncoder) {
        statusMark.textContent = "Encoder not available";
        return;
    }

    let encoder;
    try {
        encoder = await WasmMediaEncoder.createOggEncoder();
    } catch (e) {
        statusMark.textContent = "WASM load error";
        return;
    }

    const vbr = Math.min(10, Math.max(-1, parseFloat(vbrInput.value) || 3));

    encoder.configure({
        channels,
        sampleRate,
        vbrQuality: vbr
    });

    statusMark.textContent = "Encoding...";

    const frame = 4096; // samples per encoding chunk
    const total = resampled.length;
    const channelData = [];

    for (let c = 0; c < channels; c++) channelData.push(resampled.getChannelData(c));

    const pieces = [];
    let off = 0;

    while (off < total) {
        const frameCount = Math.min(frame, total - off);
        const slice = [];

        for (let c = 0; c < channels; c++) slice.push(channelData[c].subarray(off, off + frameCount));

        const out = encoder.encode(slice);

        if (out && out.length) pieces.push(new Uint8Array(out));

        off += frameCount;

        statusMark.textContent = `Encoding ${Math.round(off / total * 100)}%`;
        await new Promise(r => setTimeout(r, 0));
    }

    const last = encoder.finalize();
    if (last && last.length) pieces.push(new Uint8Array(last));

    const blob = new Blob([concatChunks(pieces)], { type: "audio/ogg; codecs = vorbis" });

    dl.href = URL.createObjectURL(blob);
    dl.download = file.name.replace(/\.[^.]+$/, "") + ".ogg";
    dl.style.display = "";
    dl.textContent = "Download";

    statusMark.textContent = "Done";
}