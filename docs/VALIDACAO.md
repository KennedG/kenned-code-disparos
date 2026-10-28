# Validação da entrega

Ambiente de compilação: Linux x64, Node.js 24.19.0, Electron 44.5.1, electron-builder 26.15.3. Distribuição Windows x64 com runtime incluído e instalador NSIS em português. Código e dependências fixadas no package-lock.json.

**63 testes passaram, zero falhas.** A saída completa está em [resultados-testes.txt](resultados-testes.txt).

Cobertura: intervalo contado entre inícios; 15 destinos e ordem texto/mídia; rodada longa sem sobreposição/acúmulo; fila global serial; pausa e parada durante espera/envio; desconexão/restrição; repetição/alternância e configurações por grupo; dias/datas/janelas noturnas; limites diários; suspensão simulada; persistência antes da rede e interrupção abrupta; recuperação sem duplicar; incerteza e confirmação posterior; tentativas limitadas; autorização de administradores; rejeição de grupo, encaminhamento, fromMe, histórico, replay e LID não verificável; confirmações com revisão/expiração/uso único; isolamento de sessões de mídia; cópia gerenciada; backup/restauração, checksum e caminhos.

Teste adicional com o **aplicativo Electron realmente aberto** em desktop virtual: seis seções, criação inicialmente desativada, alteração de ordem, seleção de grupo, prévia com estimativa, confirmação de ativação, dois envios simulados em sequência, parada global, gravação das configurações, tema claro, comando autorizado e rejeição de outro número. Imagem real da biblioteca servida por protocolo local restrito foi carregada. Não foi utilizado backend fictício da interface.

Verificações de sintaxe em todos os arquivos JS/CJS concluídas. O instalador é compilado a partir do aplicativo Windows empacotado; código do instalador preserva dados de AppData, cria atalhos e permite atalho opcional na área de trabalho.

**Limites da validação:** não há conta WhatsApp conectada, grupo de teste real indicado ou máquina Windows física neste ambiente. QR Code/ACK/identidade/mídia do adaptador real foram testados com biblioteca e eventos simulados. Não é correto afirmar que envios reais ou a instalação em Windows físico foram aprovados. Esses testes devem ocorrer posteriormente, exclusivamente no grupo que o usuário indicar. A integração não oficial e a versão candidata do Baileys estão descritas em [INTEGRACAO.md](INTEGRACAO.md).
