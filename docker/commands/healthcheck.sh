#!/bin/sh
home=/home/steam

gameversion=$(cat $home/metadata/game_version.txt)
gmodbranch=$(cat $home/metadata/game_branch.txt)
containertag=$(cat $home/metadata/container_tag.txt)
closetime=$(cat $home/metadata/container_close_timestamp.txt)


get_cpu_usage() {
    local stat1=$(head -n 1 "/proc/stat")
    
    sleep 0.15
    
    local stat2=$(head -n 1 "/proc/stat")
    
    local num_cores=$(grep -c "^processor" "/proc/cpuinfo" 2>/dev/null)
    if [ -z "$num_cores" ] || [ "$num_cores" -eq 0 ]; then
        num_cores=1
    fi

    # Pass stats as variables to awk to avoid parsing a long, single line of fields.
    # Awk handles all the floating point arithmetic.
    awk -v s1="$stat1" -v s2="$stat2" -v nc="$num_cores" '
    BEGIN {
        # Split the stat lines into arrays. The first element (e.g., a1[1]) will be "cpu".
        split(s1, a1, " ");
        split(s2, a2, " ");

        # Previous values (user, nice, system, idle, iowait, irq, softirq)
        p_user=a1[2]; p_nice=a1[3]; p_system=a1[4]; p_idle=a1[5]; p_iowait=a1[6]; p_irq=a1[7]; p_softirq=a1[8];
        
        # Current values
        c_user=a2[2]; c_nice=a2[3]; c_system=a2[4]; c_idle=a2[5]; c_iowait=a2[6]; c_irq=a2[7]; c_softirq=a2[8];

        prev_idle_total = p_idle + p_iowait;
        idle_total = c_idle + c_iowait;

        prev_non_idle_total = p_user + p_nice + p_system + p_irq + p_softirq;
        non_idle_total = c_user + c_nice + c_system + c_irq + c_softirq;

        prev_total = prev_idle_total + prev_non_idle_total;
        total = idle_total + non_idle_total;

        totald = total - prev_total;
        idled = idle_total - prev_idle_total;

        if (totald > 0) {
            # This formula calculates usage scaled by core count.
            # A result of 100 means a load equivalent to one fully utilized core.
            cpu_perc = ((totald - idled) * nc * 100) / totald;
            printf "%.0f", cpu_perc;
        } else {
            print "0";
        }
    }'
}

# get disk space remaining as a 1-100% (expecting a hard max of 4gb)
# We target the root filesystem "/" and use a 4GB maximum.
# 4GB in KB is 4 * 1024 * 1024 = 4194304.
diskusage=$(df -k "/" | awk -v total_kb=4194304 '
    NR==2 {
        available_kb = $4
        if (total_kb > 0) {
            percent = (available_kb / total_kb) * 100
            if (percent > 100) percent = 100
            if (percent < 0) percent = 0
            printf "%.0f", percent
        } else {
            print "0"
        }
    }
')

# get cpu usage as a 1-corecount*100%
cpuusage=$(get_cpu_usage)

printf "Content-Type: application/json\r\n"
printf "\r\n"
printf "{\n"
printf '  "diskusage": %s,\n'    "${diskusage:-0}"
printf '  "cpuusage": %.0f,\n'   "${cpuusage:-0}"
printf '  "gameversion": "%s",\n' "${gameversion:-unknown}"
printf '  "gmodbranch": "%s",\n'  "${gmodbranch:-unknown}"
printf '  "closetime": "%s",\n'   "${closetime:-0}"
printf '  "containertag": "%s"\n' "${containertg:-unknown}"
printf "}\n"
