# Projeto Observabilidade (Prometheus + Loki + Grafana)

Este projeto cria um ambiente de observabilidade com:
- **app** (Node.js) gerando logs e métricas simples
- **Prometheus** coletando métricas
- **Loki** armazenando logs
- **Promtail** encaminhando logs para o Loki
- **Grafana** com provisioning para dashboards e datasources

## Subir o ambiente

```bash
docker-compose up --build
```

## Acessos
- Grafana: http://localhost:3001
- Prometheus: http://localhost:9090
- Loki: http://localhost:3100

## Observação
Este exemplo usa configurações mínimas para demonstrar a estrutura. Ajustes podem ser necessários conforme o seu padrão de logs (paths) e métricas.

