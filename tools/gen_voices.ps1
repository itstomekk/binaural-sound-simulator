# Generates voice clips with Windows SAPI (Zira en-US, Paulina pl-PL) as WAV into assets/voices/_wav
Add-Type -AssemblyName System.Speech
$out = Join-Path $PSScriptRoot '..\assets\voices\_wav'
New-Item -ItemType Directory -Force $out | Out-Null
$clips = @(
  @{n='front';  v='Microsoft Zira Desktop';    t='Front.'},
  @{n='behind'; v='Microsoft Zira Desktop';    t='Behind.'},
  @{n='above';  v='Microsoft Zira Desktop';    t='Above.'},
  @{n='below';  v='Microsoft Zira Desktop';    t='Below.'},
  @{n='left';   v='Microsoft Zira Desktop';    t='Left.'},
  @{n='right';  v='Microsoft Zira Desktop';    t='Right.'},
  @{n='hello-en'; v='Microsoft Zira Desktop';  t='Hello! I am speaking from right here. Can you tell where I am?'},
  @{n='hello-pl'; v='Microsoft Paulina Desktop'; t=('Cze' + [char]0x015B + [char]0x0107 + ' Tomek! M' + [char]0xF3 + 'wi' + [char]0x0119 + ' st' + [char]0x0105 + 'd. S' + [char]0x0142 + 'yszysz, gdzie jestem?')}
)
foreach ($c in $clips) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice($c.v)
  $s.Rate = 0
  $s.SetOutputToWaveFile((Join-Path $out ($c.n + '.wav')))
  $s.Speak($c.t)
  $s.Dispose()
}
