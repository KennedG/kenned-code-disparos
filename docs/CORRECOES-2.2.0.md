# Kenned Code Disparos 2.2.0 — correções de buscas, alertas e dados

Esta versão conserva campanhas, configurações, arquivos, usuários, recuperação de senha e sessão WhatsApp. A identidade visível muda de Mega Disparos para **Kenned Code Disparos**; referências legítimas à loja Mega Celulares e textos existentes das campanhas não são reescritos.

## Causas identificadas no projeto

- BUSCAS descartava todas as mensagens `fromMe`, inclusive um comando digitado manualmente pelo dono na própria conta conectada. Uma mensagem enviada exige identificar o autor pela sessão autenticada: o `remoteJid` é a conversa de destino e não o autor.
- O caminho de envio privado precisava resolver o número no identificador suportado pela integração, incluindo a própria conta. Sem confirmação do serviço, uma entrada na fila não comprova envio. Erros no destinatário ou no serviço precisam ficar visíveis no histórico e diagnóstico, sem mudar o destino silenciosamente.
- A desconexão registrava notificação local e diagnóstico, mas não enfileirava um aviso privado. O registro de incidente descartava ocorrências sem campanha, e o seletor de destinatários sistêmicos ignorava contatos cadastrados fora de uma campanha. Isso impedia parte dos alertas críticos e de desconexão de seguir o fluxo privado.
- Grupos e dados de demonstração permaneciam no mesmo conjunto de consultas operacionais usado pelo modo real. Filtrar somente pelo nome não resolveria a origem nem protegeria cadastros legítimos.

## Fluxos corrigidos

**Comandos BUSCAS.** Mensagens manuais da própria conta exigem identidade autenticada, vínculo ao dono e conversa explicitamente habilitada. Outros usuários continuam sujeitos à autorização e às permissões configuradas. Eventos de histórico, encaminhamentos e ecos automáticos não executam comandos. O identificador durável da mensagem limita o processamento a uma vez; identificadores das automações são persistidos antes de enviar para evitar loops, inclusive após reinício. Prefixo configurável, comando vazio e ausência de ofertas mantêm respostas claras. Falhas ficam registradas e o serviço tenta encaminhar uma explicação quando houver destino autorizado e conexão.

**Destinatários.** A entrega utiliza os destinos salvos em BUSCAS e valida código do país, DDD e identificador do WhatsApp. A própria conta usa sua identidade autenticada. O teste individual de destino usa o transporte e a mesma fila de produção, sem fallback para a conversa de origem. O estado pendente identifica apenas uma intenção de envio; confirmação do servidor e confirmação de entrega, quando recebida, são estados distintos. Falhas anteriores à submissão podem ser tentadas novamente com limite; resultados incertos exigem revisão.

**Alertas.** Ocorrências sistêmicas e de campanha mantêm a notificação local e um registro separado de cada aviso privado. Desconexão, falha crítica e teste seguem a mesma fila dos alertas reais, com donos e destinatários configurados. Sem conexão, a notificação/som local é solicitado imediatamente e o privado continua pendente até reconectar, preservando o horário original. Um identificador por ocorrência/destino evita duplicidade. Tentativas têm limite; respostas ambíguas não são repetidas automaticamente. Em simulação, não há transporte real nem chamada ao canal HTTPS independente.

**Isolamento.** O esquema 6 acrescenta origem real/simulada aos registros operacionais, consultas e controles de fila. Eventos atrasados e caches da integração anterior não passam para o outro modo. Registros comprovadamente de demonstração ficam apenas na simulação; a migração usa metadados, identificadores e relações comprovadas, nunca só o nome. O modo real mostra estado vazio ou erro quando a integração não entrega grupos e dados. O aviso **SIMULAÇÃO — DADOS FICTÍCIOS** identifica as telas de teste.

**Diagnóstico.** Cada comando e ocorrência possui identificador de rastreamento. As etapas registram recepção manual/externa, autorização, interpretação, quantidade encontrada, destino, fila e retorno do transporte. Falha da campanha e falha no aviso permanecem eventos distintos. Logs não incluem senhas, tokens ou credenciais.

## Atualização da identidade sem perder dados

O aplicativo seleciona explicitamente `%APPDATA%\Mega Disparos` antes de adquirir o bloqueio de instância. O appId/AUMID `br.com.megadisparos.desktop`, chaves de atualização e formato de backups permanecem compatíveis. Não há criação de perfil vazio nem regravação do hash dos códigos de recuperação.

A janela, login/cadastro, menu, Sobre, notificações, bandeja, mensagens automáticas novas, executável, instalador e atalhos mostram **Kenned Code Disparos**. A pasta de instalação antiga continua aceita para atualização. O instalador substitui somente atalhos conhecidos e remove o executável antigo apenas quando o manifesto de propriedade o identifica; arquivos desconhecidos e AppData são preservados. Comandos de campanhas `!mega` e arquivos `.mega.json` mantêm compatibilidade.

## Validação e pendências

Consulte [VALIDACAO.md](VALIDACAO.md) para o resultado consolidado e os testes da entrega. A fachada desktop passou em seis fluxos, incluindo a nova identidade, diretório legado, credenciais e banco preservados.

**Não houve conta WhatsApp conectada nem Windows físico disponível neste ambiente.** Não foi possível verificar o envio real ao próprio número, aos destinatários, nem recibos ou notificações físicas. Os testes de transporte utilizam eventos controlados da biblioteca instalada e não são apresentados como entrega real. Depois de instalar, conecte a conta, confira o vínculo do dono, habilite os locais BUSCAS e use os testes individuais de envio/alerta; um teste de grupo real deve ocorrer somente no grupo indicado pelo usuário. A integração Baileys continua **não oficial**.
