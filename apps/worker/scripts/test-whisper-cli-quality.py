"""Exercise the actual pinned CLI JSON exporter with synthetic C API data, no models/GPU."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(sys.argv.pop(1))

STUB = r'''
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>
struct whisper_context { bool vad; bool empty; };
struct whisper_params {
 bool output_jsn_full=true, diarize=false, tinydiarize=false, vad=false, translate=false;
 std::string model="synthetic.bin", language="auto";
};
struct whisper_token_data { int id; float p; int64_t t0,t1; float t_dtw; };
const char * whisper_print_system_info(){return "synthetic CPU exporter contract";}
const char * whisper_model_type_readable(whisper_context*){return "small";}
int whisper_is_multilingual(whisper_context*){return 1;}
int whisper_model_n_vocab(whisper_context*){return 50000;}
int whisper_model_n_audio_ctx(whisper_context*){return 1500;}
int whisper_model_n_audio_state(whisper_context*){return 768;}
int whisper_model_n_audio_head(whisper_context*){return 12;}
int whisper_model_n_audio_layer(whisper_context*){return 12;}
int whisper_model_n_text_ctx(whisper_context*){return 448;}
int whisper_model_n_text_state(whisper_context*){return 768;}
int whisper_model_n_text_head(whisper_context*){return 12;}
int whisper_model_n_text_layer(whisper_context*){return 12;}
int whisper_model_n_mels(whisper_context*){return 80;}
int whisper_model_ftype(whisper_context*){return 1;}
int whisper_full_lang_id(whisper_context*c){return c->empty ? -1 : 0;}
const char * whisper_lang_str(int id){return id<0 ? nullptr : "en";}
int whisper_full_n_segments(whisper_context*c){return c->empty ? 0 : 1;}
const char * whisper_full_get_segment_text(whisper_context*,int){return " Quiet words.";}
int64_t whisper_full_get_segment_t0(whisper_context*c,int){return c->vad ? 1000 : 0;}
int64_t whisper_full_get_segment_t1(whisper_context*c,int){return c->vad ? 1100 : 100;}
float whisper_full_get_segment_no_speech_prob(whisper_context*,int){return .12f;}
int whisper_full_n_tokens(whisper_context*,int){return 2;}
whisper_token_data whisper_full_get_token_data(whisper_context*,int,int j){return {j,.9f,j*50,(j+1)*50,-1};}
const char * whisper_token_to_str(whisper_context*,int id){return id==0 ? " Quiet" : " words.";}
int64_t whisper_full_get_token_t0(whisper_context*c,int,int j){return j*50+(c->vad?1000:0);}
int64_t whisper_full_get_token_t1(whisper_context*c,int,int j){return (j+1)*50+(c->vad?1000:0);}
int whisper_full_n_vad_segments(whisper_context*c){return c->empty ? 0 : 1;}
int64_t whisper_full_get_vad_segment_t0(whisper_context*,int){return 1000;}
int64_t whisper_full_get_vad_segment_t1(whisper_context*,int){return 1100;}
bool whisper_full_get_segment_speaker_turn_next(whisper_context*,int){return false;}
std::string estimate_diarization_speaker(std::vector<std::vector<float>>,int64_t,int64_t,bool){return "0";}
std::string to_timestamp(int64_t,bool){return "00:00:00.000";}
char * escape_double_quotes_and_backslashes(const char *p){return strdup(p);}
int utf8_trailing_bytes_needed(const std::string&){return 0;}
'''

MAIN = r'''
int main(int argc,char **argv){
 if(argc!=3)return 2;
 const std::string mode=argv[2];
 whisper_context ctx{mode!="plain",mode=="empty"};
 whisper_params params;params.vad=ctx.vad;
 std::ofstream out(argv[1]);output_json(&ctx,out,params,{});return 0;
}
'''


class ExporterContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = SOURCE.read_text()
        start = source.index('static void output_json(')
        end = source.index('// karaoke video generation', start)
        cls.temporary = tempfile.TemporaryDirectory(prefix='whisper-json-quality-')
        cls.directory = Path(cls.temporary.name)
        path = cls.directory / 'exporter.cpp'
        path.write_text(STUB + source[start:end] + MAIN)
        cls.binary = cls.directory / 'exporter'
        run = subprocess.run(['c++', '-std=c++17', '-O0', str(path), '-o', str(cls.binary)], capture_output=True, text=True, timeout=30)
        if run.returncode:
            raise RuntimeError('Synthetic exporter compile failed: ' + run.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def output(self, mode):
        path = self.directory / (mode + '.json')
        run = subprocess.run([str(self.binary), str(path), mode], capture_output=True, timeout=5)
        self.assertEqual(run.returncode, 0, 'Exporter failed on synthetic ' + mode)
        return json.loads(path.read_text())

    def test_vad_token_offsets_use_original_clock_and_keep_no_speech_evidence(self):
        value = self.output('vad')
        segment = value['transcription'][0]
        self.assertEqual(segment['offsets'], {'from': 10000, 'to': 11000})
        self.assertEqual(segment['tokens'][0]['offsets'], {'from': 10000, 'to': 10500})
        self.assertEqual(segment['tokens'][1]['offsets'], {'from': 10500, 'to': 11000})
        self.assertAlmostEqual(segment['no_speech_probability'], .12)
        self.assertEqual(value['bitovp_quality']['version'], 'bitovp-mapped-quality-v1')
        self.assertEqual(value['bitovp_quality']['speech_intervals'][0]['offsets'], {'from': 10000, 'to': 11000})

    def test_without_vad_keeps_original_uncompressed_clock(self):
        value = self.output('plain')
        self.assertEqual(value['transcription'][0]['tokens'][0]['offsets'], {'from': 0, 'to': 500})
        self.assertFalse(value['bitovp_quality']['vad'])

    def test_no_speech_is_valid_empty_output_with_no_invented_language(self):
        value = self.output('empty')
        self.assertEqual(value['transcription'], [])
        self.assertEqual(value['result']['language'], 'und')
        self.assertEqual(value['bitovp_quality']['speech_intervals'], [])


if __name__ == '__main__':
    unittest.main()
