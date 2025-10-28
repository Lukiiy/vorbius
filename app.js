const $ = id => document.getElementById(id);

const fileInput = $('file');
const vbrInput = $('vbr');
const srInput = $('sr');
const monoInput = $('mono');

const btn = $('convert');
const statusMark = $('status');
const dl = $('download');

const offContext = window.OfflineAudioContext || window.AudioContext;

// Decode input into an AudioBuffer
const decode = async file => {
    const arrayBuf = await file.arrayBuffer();
    const ctx = new offContext(1, 1, 44100);

    return await new Promise((res, rej) => ctx.decodeAudioData(arrayBuf, res, rej));
};

// Resample an AudioBuffer to target sampleRate and maybe change some other stuff
const resampleAndMix = (audioBuffer, targetRate, toMono) => {
    const channels = toMono ? 1 : audioBuffer.numberOfChannels;
    const len = Math.ceil(audioBuffer.duration * targetRate);
    const offline = new offContext(channels, len, targetRate);
    const buf = offline.createBuffer(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);

    for (let c = 0; c < audioBuffer.numberOfChannels; c++) buf.copyToChannel(audioBuffer.getChannelData(c), c);

    const source = offline.createBufferSource();
    source.buffer = buf;
    source.connect(offline.destination);
    source.start();

    return offline.startRendering();
};

// Concatenate an array of Uint8Array chunks into a single Uint8Array
const concatChunks = chunks => {
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;

    const out = new Uint8Array(total);
    let p = 0;

    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        out.set(c, p);
        p += c.length;
    }

    return out;
};

btn.addEventListener('click', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
        statusMark.textContent = "Select a file";
        return;
    }

    statusMark.textContent = "Decoding...";
    let audio;

    try { audio = await decode(file); }
    catch (e) {
        statusMark.textContent = "Decoding error";
        return;
    }

    const targetSR = Math.max(8000, Math.min(48000, parseInt(srInput.value) || 44100));
    const toMono = monoInput.checked;

    statusMark.textContent = `Resampling to ${targetSR} Hz${toMono ? ", mono" : ""}...`;

    let pcm;
    try { pcm = await resampleAndMix(audio, targetSR, toMono); }
    catch (e) {
        statusMark.textContent = "Resample error";
        return;
    }

    const channels = toMono ? 1 : pcm.numberOfChannels;
    const sampleRate = pcm.sampleRate;

    statusMark.textContent = "Loading encoder...";
    if (!window.WasmMediaEncoder || !WasmMediaEncoder.createOggEncoder) {
        statusMark.textContent = "Encoder not available";
        return;
    }

    let enc;
    try { enc = await WasmMediaEncoder.createOggEncoder(); }
    catch (e) {
        statusMark.textContent = "WASM load error";
        return;
    }

    const vbr = Math.min(10, Math.max(-1, parseFloat(vbrInput.value) || 3));
    enc.configure({ channels, sampleRate, vbrQuality: vbr });

    statusMark.textContent = "Encoding...";
    const frame = 4096;
    const total = pcm.length;
    const chData = [];

    for (let c = 0; c < channels; c++) chData.push(pcm.getChannelData(c));
    const pieces = [];
    let off = 0;
    while (off < total) {
        const n = Math.min(frame, total - off);
        const slice = [];

        for (let c = 0; c < channels; c++) slice.push(chData[c].subarray(off, off+n));
        const out = enc.encode(slice);

        if (out && out.length) pieces.push(new Uint8Array(out));
        off += n;

        statusMark.textContent = `Encoding ${Math.round(off / total * 100)}%`;
        await new Promise(r => setTimeout(r, 0));
    }

    const last = enc.finalize(); if (last && last.length) pieces.push(new Uint8Array(last));
    const outFile = concatChunks(pieces);
    const blob = new Blob([outFile.buffer], { type: "audio/ogg" });

    dl.href = URL.createObjectURL(blob);
    dl.download = file.name.replace(/\.[^.]+$/, "") + ".ogg";
    dl.style.display = "inline";
    dl.textContent = "Download";
    statusMark.textContent = "Done";
});