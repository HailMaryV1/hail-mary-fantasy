"""
import_lineup_probability.py
-----------------------------
Loads a weekly batch of "projected lineup" graphics (Solio Analytics /
@FPL_Spaceman) into player_lineup_probability (migration 0110). These are
screenshotted by the user and transcribed by hand into the DATA structure
below each week - there's no API, this isn't scraped.

Each graphic shows, per formation slot, every realistic candidate with a
real modelled start percentage (not just a binary "starter" flag) - the
gap between the top two candidates in a slot IS the rotation-risk signal,
so every candidate is captured, not just the top one.

Matching: raw_name (often abbreviated - "B.Fernandes", "E.Le Fée") is
matched against players scoped to the graphic's own team_id by surname,
same technique as import_dreamteam.py/import_fanteam_live.py's own
surname-key matching. A row that can't be confidently matched is inserted
with player_id = NULL rather than guessed - raw_name is always kept so a
later re-match never loses information.

Deliberately writes to its own landing table only - see migration 0110's
docstring for why this isn't wired into compute_projections.py yet.

RUN:
    python3 scripts/import_lineup_probability.py [--snapshot-date YYYY-MM-DD]
"""
import argparse
import os
import re
import sys
import unicodedata
from datetime import date, datetime
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent

SOURCE = "solio_analytics_fpl_spaceman"

# Each entry: (team_name, formation, [(position_slot, [(raw_name, pct, is_new), ...]), ...])
# Candidates are already ordered by percentage (slot_rank = list position, 1-based).
DATA = [
    ("Sunderland", "4-2-3-1", [
        ("ST", [("Brobbey", 94, False), ("Isidor", 6, False)]),
        ("LW", [("Talbi", 73, False), ("E.Le Fée", 21, False), ("Angulo", 6, False)]),
        ("CAM", [("E.Le Fée", 74, False), ("Diarra", 22, False), ("Rigg", 4, False)]),
        ("RW", [("Hume", 57, False), ("Diarra", 17, False), ("Angulo", 14, False), ("Jocelin.T", 12, False)]),
        ("LDM", [("Sadiki", 99, False), ("Xhaka", 1, False)]),
        ("RDM", [("Xhaka", 94, False), ("Diarra", 6, False)]),
        ("LB", [("Reinildo", 93, False), ("Hume", 5, False), ("Masuaku", 2, False)]),
        ("RB", [("Mukiele", 79, False), ("Thomas Meunier", 15, False), ("Hume", 6, False)]),
        ("LCB", [("Alderete", 80, False), ("O'Nien", 10, False), ("Ballard", 8, False), ("Hjelde", 2, False)]),
        ("RCB", [("Ballard", 85, False), ("Mukiele", 11, False), ("Seelt", 4, False)]),
        ("GK", [("Roefs", 99, False), ("Ellborg", 1, False)]),
    ]),
    ("Tottenham Hotspur", "4-2-3-1", [
        ("ST", [("Solanke", 82, False), ("Richarlison", 15, False), ("Tel", 3, False)]),
        ("LW", [("Xavi", 49, False), ("Tel", 39, False), ("Richarlison", 9, False), ("Maddison", 3, False)]),
        ("CAM", [("Gallagher", 53, False), ("Maddison", 45, False), ("P.M.Sarr", 2, False)]),
        ("RW", [("Kudus", 61, False), ("Kulusevski", 15, False), ("Xavi", 14, False), ("Odobert", 10, False)]),
        ("LDM", [("M.Fernandes", 89, False), ("Bentancur", 8, False), ("Gallagher", 3, False)]),
        ("RDM", [("Tonali", 94, False), ("Gray", 5, False), ("Bergvall", 1, False)]),
        ("LB", [("Spence", 52, False), ("Robertson", 30, False), ("Udogie", 13, False), ("Van de Ven", 5, False)]),
        ("RB", [("Pedro Porro", 95, False), ("Spence", 3, False), ("Gray", 2, False)]),
        ("LCB", [("Van de Ven", 90, False), ("Senesi", 10, False)]),
        ("RCB", [("Van Hecke", 95, False), ("Danso", 5, False)]),
        ("GK", [("Kinsky", 99, False), ("Dúbravka", 1, False)]),
    ]),
    ("Nottingham Forest", "3-4-2-1", [
        ("LW", [("Hudson-Odoi", 66, False), ("Ndoye", 23, False), ("Bakwa", 8, False), ("Dominguez", 3, False)]),
        ("ST", [("Igor Jesus", 78, False), ("Wood", 21, False), ("Awoniyi", 1, False)]),
        ("RW", [("Gibbs-White", 93, False), ("Hutchinson", 4, False), ("Igor Jesus", 3, False)]),
        ("LWB", [("N.Williams", 96, False), ("Netz", 2, False), ("Gibbs-White", 2, False)]),
        ("LDM", [("Xaver Schlager", 72, False), ("Dominguez", 28, False)]),
        ("RDM", [("Sangaré", 88, False), ("Yates", 12, False)]),
        ("RWB", [("Aina", 85, False), ("Savona", 10, False), ("N.Williams", 5, False)]),
        ("LCB", [("Murillo", 92, False), ("Morato", 8, False)]),
        ("CB", [("Milenković", 98, False), ("Morato", 2, False)]),
        ("RCB", [("Diomande", 80, True), ("Jair Cunha", 20, False)]),
        ("GK", [("Sels", 99, False), ("John", 1, False)]),
    ]),
    ("Manchester United", "4-2-3-1", [
        ("ST", [("Šeško", 70, False), ("Mbeumo", 24, False), ("Cunha", 5, False), ("Zirkzee", 1, False)]),
        ("LW", [("Cunha", 78, False), ("Dorgu", 16, False), ("Amad", 6, False)]),
        ("CAM", [("B.Fernandes", 98, False), ("Mount", 1, False), ("Lacey", 1, False)]),
        ("RW", [("Mbeumo", 60, False), ("Amad", 40, False)]),
        ("LDM", [("Tielemans", 88, False), ("Mount", 7, False), ("B.Fernandes", 3, False), ("Ugarte", 2, False)]),
        ("RDM", [("Andrey Santos", 71, False), ("Mainoo", 29, False)]),
        ("LB", [("Shaw", 82, False), ("Mazraoui", 10, False), ("Dorgu", 5, False), ("Dalot", 3, False)]),
        ("RB", [("Dalot", 74, False), ("Mazraoui", 16, False), ("Yoro", 10, False)]),
        ("LCB", [("Martinez", 95, False), ("Heaven", 5, False)]),
        ("RCB", [("Maguire", 51, False), ("De Ligt", 36, False), ("Yoro", 13, False)]),
        ("GK", [("Lammens", 99, False), ("Darlow", 1, False)]),
    ]),
    ("Newcastle United", "4-2-3-1", [
        ("ST", [("Osula", 55, False), ("Wissa", 38, False), ("Woltemade", 7, False)]),
        ("LW", [("Barnes", 64, False), ("Bazoumana Touré", 29, False), ("J.Ramsey", 4, False), ("Joelinton", 3, False)]),
        ("CAM", [("Woltemade", 72, False), ("Joelinton", 20, False), ("J.Ramsey", 8, False)]),
        ("RW", [("J.Murphy", 61, False), ("Elanga", 29, False), ("Barnes", 10, False)]),
        ("LDM", [("J.Ramsey", 40, False), ("L.Miley", 32, False), ("Joelinton", 28, False)]),
        ("RDM", [("Aladji Bamba", 66, False), ("Sean Steur", 29, False), ("Willock", 5, False)]),
        ("LB", [("Hall", 85, False), ("Burn", 13, False), ("Livramento", 2, False)]),
        ("RB", [("Livramento", 90, False), ("L.Miley", 7, False), ("Shahar", 3, False)]),
        ("LCB", [("Botman", 74, False), ("Burn", 26, False)]),
        ("RCB", [("Thiaw", 94, False), ("Schär", 6, False)]),
        ("GK", [("Lukás Hornícek", 99, False), ("Jaouen", 1, False)]),
    ]),
    ("Liverpool", "4-2-3-1", [
        ("ST", [("Isak", 68, False), ("Ekitiké", 22, False), ("Gakpo", 9, False), ("Chiesa", 1, False)]),
        ("LW", [("Gakpo", 61, False), ("Muñoz", 18, False), ("Ngumoha", 17, False), ("Wirtz", 4, False)]),
        ("CAM", [("Wirtz", 90, False), ("Szoboszlai", 7, False), ("Mac Allister", 3, False)]),
        ("RW", [("Ngumoha", 49, False), ("Szoboszlai", 33, False), ("Frimpong", 13, False), ("Chiesa", 5, False)]),
        ("LDM", [("Szoboszlai", 53, False), ("Mac Allister", 46, False), ("Endo", 1, False)]),
        ("RDM", [("Gravenberch", 85, False), ("C.Jones", 15, False)]),
        ("LB", [("Kerkez", 92, False), ("Tsimikas", 8, False)]),
        ("RB", [("Bradley", 44, False), ("Frimpong", 38, False), ("C.Jones", 10, False), ("Gomez", 8, False)]),
        ("LCB", [("Virgil", 98, False), ("Endo", 1, False), ("Leoni", 1, False)]),
        ("RCB", [("Araújo", 80, True), ("Jacquet", 14, False), ("Gomez", 5, False), ("Gravenberch", 1, False)]),
        ("GK", [("A.Becker", 96, False), ("Mamardashvili", 4, False)]),
    ]),
    ("Leeds United", "3-4-2-1", [
        ("LW", [("Okafor", 81, False), ("Aaronson", 10, False), ("Stach", 6, False), ("Gnonto", 3, False)]),
        ("ST", [("Calvert-Lewin", 95, False), ("Nmecha", 4, False), ("Okafor", 1, False)]),
        ("RW", [("Wilson", 90, False), ("Aaronson", 9, False), ("James", 1, False)]),
        ("LWB", [("Gudmundsson", 83, False), ("Justin", 17, False)]),
        ("LDM", [("Stach", 85, False), ("Gruev", 8, False), ("Tanaka", 7, False)]),
        ("RDM", [("Ampadu", 95, False), ("Longstaff", 5, False)]),
        ("RWB", [("Bogle", 77, False), ("Justin", 17, False), ("James", 6, False)]),
        ("LCB", [("Tarik Muharemović", 94, False), ("Bornauw", 6, False)]),
        ("CB", [("Bijol", 85, False), ("Rodon", 15, False)]),
        ("RCB", [("Rodon", 80, False), ("Justin", 20, False)]),
        ("GK", [("Trafford", 99, False), ("Perri", 1, False)]),
    ]),
    ("Manchester City", "4-2-3-1", [
        ("ST", [("Haaland", 96, False), ("Marmoush", 2, False), ("Semenyo", 2, False)]),
        ("LW", [("Doku", 77, False), ("Savinho", 9, False), ("Marmoush", 8, False), ("Semenyo", 6, False)]),
        ("CAM", [("Cherki", 51, False), ("Foden", 45, False), ("Semenyo", 4, False)]),
        ("RW", [("Semenyo", 83, False), ("Foden", 13, False), ("Savinho", 4, False)]),
        ("LDM", [("Anderson", 73, False), ("O'Reilly", 22, False), ("Kovačić", 3, False), ("Reijnders", 2, False)]),
        ("RDM", [("Rodrigo", 81, False), ("N.Gonzalez", 19, False)]),
        ("LB", [("O'Reilly", 61, False), ("Aït-Nouri", 24, False), ("Gvardiol", 15, False)]),
        ("RB", [("Matheus N.", 86, False), ("Khusanov", 12, False), ("Lewis", 2, False)]),
        ("LCB", [("Gvardiol", 74, False), ("Rúben", 26, False)]),
        ("RCB", [("Guéhi", 77, False), ("Rúben", 20, False), ("Khusanov", 3, False)]),
        ("GK", [("Donnarumma", 98, False), ("Rulli", 2, True)]),
    ]),
    ("Hull City", "4-2-3-1", [
        ("ST", [("McBurnie", 99, False), ("Destan", 1, False)]),
        ("LW", [("Millar", 81, False), ("Kamara", 11, False), ("Dowell", 5, False), ("Belloumi", 3, False)]),
        ("CAM", [("Hjertø-Dahl", 70, True), ("Belloumi", 13, False), ("Millar", 9, False), ("Ömür", 8, False)]),
        ("RW", [("Belloumi", 60, False), ("Crooks", 22, False), ("David", 13, False), ("Kamara", 5, False)]),
        ("LDM", [("Slater", 68, False), ("Zambrano", 32, False)]),
        ("RDM", [("Crooks", 51, False), ("Hidemasa Morita", 49, False)]),
        ("LB", [("Giles", 72, False), ("Targett", 26, False), ("Jacob", 2, False)]),
        ("RB", [("Coyle", 81, False), ("Drameh", 19, False)]),
        ("LCB", [("Hughes", 73, False), ("Ajayi", 27, False)]),
        ("RCB", [("Egan", 92, False), ("McNair", 7, False), ("McCarthy", 1, False)]),
        ("GK", [("Konstantinos Tzolakis", 99, False), ("Butland", 1, False)]),
    ]),
    ("Fulham", "4-2-3-1", [
        ("ST", [("Gonzalo García", 90, False), ("Muniz", 9, False), ("Kusi-Asare", 1, False)]),
        ("LW", [("Kevin", 51, False), ("Bobb", 27, False), ("Iwobi", 13, False), ("César Palacios", 9, False)]),
        ("CAM", [("King", 45, False), ("Smith Rowe", 38, False), ("César Palacios", 14, False), ("Iwobi", 3, False)]),
        ("RW", [("Bobb", 75, False), ("Kevin", 25, False)]),
        ("LDM", [("Berge", 95, False), ("Reed", 5, False)]),
        ("RDM", [("Iwobi", 87, False), ("Cairney", 13, False)]),
        ("LB", [("Robinson", 61, False), ("Sessegnon", 39, False)]),
        ("RB", [("Tete", 65, False), ("Castagne", 35, False)]),
        ("LCB", [("Bassey", 78, False), ("J.Cuenca", 22, False)]),
        ("RCB", [("Andersen", 80, False), ("New Signing?", 20, True)]),
        ("GK", [("Leno", 99, False), ("Lecomte", 1, False)]),
    ]),
    ("Everton", "4-2-3-1", [
        ("ST", [("Barry", 71, False), ("Beto", 29, False)]),
        ("LW", [("Ndiaye", 93, False), ("George", 5, False), ("Armstrong", 2, False)]),
        ("CAM", [("Dewsbury-Hall", 96, False), ("Alcaraz", 2, False), ("McNeil", 2, False)]),
        ("RW", [("Hayden Hackney", 42, False), ("George", 23, False), ("Röhl", 21, False), ("Dibling", 14, False)]),
        ("LDM", [("Garner", 97, False), ("Hayden Hackney", 3, False)]),
        ("RDM", [("Nørgaard", 87, False), ("Iroegbunam", 13, False)]),
        ("LB", [("Mykolenko", 89, False), ("Branthwaite", 11, False)]),
        ("RB", [("O'Brien", 76, False), ("New Signing?", 20, True), ("Patterson", 2, False), ("Garner", 1, False), ("Röhl", 1, False)]),
        ("LCB", [("Branthwaite", 82, False), ("Keane", 18, False)]),
        ("RCB", [("Tarkowski", 85, False), ("O'Brien", 15, False)]),
        ("GK", [("Pickford", 99, False), ("Travers", 1, False)]),
    ]),
    ("Crystal Palace", "3-4-2-1", [
        ("ST", [("Mateta", 67, False), ("Strand Larsen", 33, False)]),
        ("LAM", [("Yeremy", 75, False), ("Johnson", 10, False), ("Kamada", 8, False), ("Nketiah", 7, False)]),
        ("RAM", [("Sarr", 95, False), ("Devenny", 1, False)]),
        ("LWB", [("Mitchell", 62, False), ("Óscar Mingueza", 38, False)]),
        ("LCM", [("Kamada", 45, False), ("Hughes", 45, False), ("Lerma", 10, False)]),
        ("RCM", [("Wharton", 96, False), ("Lerma", 4, False)]),
        ("RWB", [("Muñoz", 94, False), ("Óscar Mingueza", 6, False)]),
        ("LCB", [("Canvot", 90, False), ("Chadi Riad", 10, False)]),
        ("CB", [("Richards", 95, False), ("Lerma", 5, False)]),
        ("RCB", [("Tomiyasu", 90, True), ("Richards", 5, False), ("Canvot", 5, False)]),
        ("GK", [("Henderson", 99, False), ("Benitez", 1, False)]),
    ]),
    ("Ipswich Town", "4-2-3-1", [
        ("ST", [("Daizen Maeda", 47, False), ("Emersonn", 37, False), ("Hirst", 14, False), ("Al-Hamadi", 2, False)]),
        ("LW", [("Jaden", 51, False), ("Daizen Maeda", 32, False), ("Mehmeti", 13, False), ("Szmodics", 4, False)]),
        ("CAM", [("Núñez", 65, False), ("Mehmeti", 20, False), ("Burns", 9, False), ("Walle Egeli", 6, False)]),
        ("RW", [("A.Fatawu", 59, False), ("J.Clarke", 27, False), ("Burns", 8, False), ("Walle Egeli", 6, False)]),
        ("LDM", [("Taylor", 63, False), ("Núñez", 27, False), ("Mehmeti", 10, False)]),
        ("RDM", [("Florentino", 56, False), ("Matusiwa", 44, False)]),
        ("LB", [("Davis", 93, False), ("Greaves", 7, False)]),
        ("RB", [("Furlong", 88, False), ("Johnson", 12, False)]),
        ("LCB", [("Diop", 65, False), ("Greaves", 35, False)]),
        ("RCB", [("O'Shea", 94, False), ("Kipre", 6, False)]),
        ("GK", [("Scherpen", 97, False), ("Palmer", 3, False)]),
    ]),
    ("Chelsea", "4-2-3-1", [
        ("ST", [("João Pedro", 83, False), ("Welbeck", 15, False), ("Delap", 2, False)]),
        ("LW", [("Neto", 54, False), ("Rogers", 34, False), ("João Pedro", 10, False), ("Quenda", 2, False)]),
        ("CAM", [("Rogers", 58, False), ("Palmer", 37, False), ("Enzo", 5, False)]),
        ("RW", [("Palmer", 55, False), ("Estêvão", 30, False), ("Quenda", 9, False), ("Neto", 6, False)]),
        ("LDM", [("Caicedo", 91, False), ("Barco", 7, False), ("Lavia", 2, False)]),
        ("RDM", [("Enzo", 75, False), ("James", 21, False), ("Henderson", 4, False)]),
        ("LB", [("Hato", 65, False), ("Gusto", 20, False), ("Barco", 11, False), ("Quenda", 4, False)]),
        ("RB", [("James", 72, False), ("Palestra", 25, False), ("Gusto", 3, False)]),
        ("LCB", [("Colwill", 88, False), ("Hato", 8, False), ("B.Badiashile", 4, False)]),
        ("RCB", [("Lacroix", 78, False), ("Fofana", 16, False), ("Acheampong", 4, False), ("Tosin", 2, False)]),
        ("GK", [("Sánchez", 98, False), ("Penders", 2, False)]),
    ]),
    ("Brighton", "4-2-3-1", [
        ("ST", [("Georginio", 54, False), ("Kostoulas", 41, False), ("Tzimas", 5, False)]),
        ("LW", [("Minteh", 50, False), ("Mitoma", 40, False), ("De Cuyper", 8, False), ("Zadok Yohanna", 2, False)]),
        ("CAM", [("Hinshelwood", 75, False), ("Georginio", 15, False), ("Gomez", 6, False), ("Kostoulas", 4, False)]),
        ("RW", [("Gomez", 66, False), ("Minteh", 29, False), ("Zadok Yohanna", 5, False)]),
        ("LDM", [("Gross", 95, False), ("Hinshelwood", 5, False)]),
        ("RDM", [("Baleba", 74, False), ("Ayari", 26, False)]),
        ("LB", [("F.Kadıoğlu", 84, False), ("De Cuyper", 11, False), ("Boscagli", 3, False), ("Struijk", 2, False)]),
        ("RB", [("Wieffer", 85, False), ("Costinha", 11, False), ("F.Kadıoğlu", 4, False)]),
        ("LCB", [("Struijk", 87, False), ("Dunk", 11, False), ("Boscagli", 2, False), ("Coppola", 0, False)]),
        ("RCB", [("Dunk", 63, False), ("Vuskovic", 28, False), ("Michael Svoboda", 9, False)]),
        ("GK", [("Verbruggen", 99, False), ("Steele", 1, False)]),
    ]),
    ("Brentford", "4-2-3-1", [
        ("ST", [("Thiago", 95, False), ("Wilson", 4, False), ("Schade", 1, False)]),
        ("LW", [("Schade", 75, False), ("Anthony", 20, False), ("Lewis-Potter", 3, False), ("O.Dango", 2, False)]),
        ("CAM", [("Damsgaard", 56, False), ("Jensen", 44, False)]),
        ("RW", [("O.Dango", 91, False), ("Anthony", 7, False), ("Jensen", 2, False)]),
        ("LDM", [("Yarmoliuk", 95, False), ("Jensen", 5, False)]),
        ("RDM", [("Mamadou Sangaré", 82, False), ("Janelt", 18, False)]),
        ("LB", [("Lewis-Potter", 48, False), ("Henry", 35, False), ("Ajer", 14, False), ("Hickey", 3, False)]),
        ("RB", [("Kayode", 96, False), ("Hickey", 2, False), ("Ajer", 2, False)]),
        ("LCB", [("Collins", 95, False), ("Pinnock", 5, False)]),
        ("RCB", [("Van den Berg", 72, False), ("Ajer", 28, False)]),
        ("GK", [("Kelleher", 99, False), ("Valdimarsson", 1, False)]),
    ]),
    ("Coventry City", "4-2-3-1", [
        ("ST", [("Wright", 72, False), ("Simms", 22, False), ("Thomas-Asante", 6, False)]),
        ("LW", [("Mason-Clark", 76, False), ("Thomas-Asante", 9, False), ("Eccles", 8, False), ("Tchaouna", 7, False)]),
        ("CAM", [("Sakamoto", 70, False), ("Rudoni", 13, False), ("Eccles", 10, False), ("Mason-Clark", 7, False)]),
        ("RW", [("Tchaouna", 62, False), ("Sakamoto", 21, False), ("Rudoni", 9, False), ("Thomas-Asante", 8, False)]),
        ("LDM", [("Grimes", 95, False), ("Eccles", 5, False)]),
        ("RDM", [("Torp", 83, False), ("Onyeka", 9, False), ("Rudoni", 8, False)]),
        ("LB", [("DaSilva", 97, False), ("Bidwell", 3, False)]),
        ("RB", [("Van Ewijk", 96, False), ("Kesler-Hayden", 4, False)]),
        ("LCB", [("Kitching", 88, False), ("Woolfenden", 12, False)]),
        ("RCB", [("Thomas", 83, False), ("Aurèle Amenda", 17, False)]),
        ("GK", [("Rushworth", 99, False), ("Wilson", 1, False)]),
    ]),
    ("Arsenal", "4-3-3", [
        ("ST", [("Gyökeres", 50, False), ("Havertz", 46, False), ("G.Jesus", 4, False)]),
        ("LW", [("Tzolis", 39, False), ("Martinelli", 35, False), ("Eze", 26, False)]),
        ("RW", [("Saka", 84, False), ("Madueke", 13, False), ("Dowman", 3, False)]),
        ("LCM", [("Rice", 65, False), ("Eze", 30, False), ("Lewis-Skelly", 5, False)]),
        ("RCM", [("Ødegaard", 55, False), ("Bruno G.", 40, True), ("Merino", 5, False)]),
        ("DM", [("Zubimendi", 44, False), ("Lewis-Skelly", 36, False), ("Bruno G.", 20, True)]),
        ("LB", [("Calafiori", 72, False), ("Hincapie", 28, False)]),
        ("RB", [("J.Timber", 86, False), ("White", 9, False), ("Mosquera", 5, False)]),
        ("LCB", [("Gabriel", 97, False), ("Hincapie", 3, False)]),
        ("RCB", [("Saliba", 96, False), ("Mosquera", 4, False)]),
        ("GK", [("Raya", 100, False)]),
    ]),
    ("Aston Villa", "4-2-3-1", [
        ("ST", [("Watkins", 87, False), ("Abraham", 10, False), ("Guessand", 3, False)]),
        ("LW", [("Garnacho", 48, False), ("Buendía", 48, False), ("Barkley", 4, False)]),
        ("CAM", [("Johan Manzambi", 64, False), ("Buendía", 33, False), ("Barkley", 3, False)]),
        ("RW", [("McGinn", 79, False), ("Barkley", 8, False), ("Garnacho", 7, False), ("Guessand", 6, False)]),
        ("LDM", [("J.Gomes", 92, False), ("Bogarde", 5, False), ("Barkley", 3, False)]),
        ("RDM", [("Kamara", 50, False), ("Onana", 37, False), ("Lindelöf", 13, False)]),
        ("LB", [("Maatsen", 55, False), ("Ruggeri", 40, True), ("Digne", 5, False)]),
        ("RB", [("Cash", 88, False), ("Lindelöf", 10, False), ("Bogarde", 2, False)]),
        ("LCB", [("Pau", 59, False), ("Mings", 41, False)]),
        ("RCB", [("Konsa", 90, False), ("Lindelöf", 10, False)]),
        ("GK", [("Martinez", 99, False), ("M.Bizot", 1, False)]),
    ]),
]


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def surname_key(raw_name: str) -> str:
    """Best-effort surname extraction from graphic-style names ('B.Fernandes',
    'E.Le Fée', 'Van de Ven', 'McBurnie') for matching against a team's real
    roster. Lowercased, accent-stripped, non-alnum removed."""
    name = raw_name
    # Strip a leading single-letter initial + dot ("B.Fernandes" -> "Fernandes")
    name = re.sub(r"^[A-Z]\.\s*", "", name)
    # If there's still a space-separated multi-word name, take the last word
    # as the primary surname key candidate, but keep the full cleaned string
    # too since some entries ARE the surname with a particle ("Van de Ven").
    cleaned = strip_accents(name).lower()
    cleaned = re.sub(r"[^a-z]", "", cleaned)
    return cleaned


def match_player(cur, team_id, raw_name):
    if raw_name in ("New Signing?",):
        return None
    key = surname_key(raw_name)
    if not key:
        return None
    cur.execute(
        "select id, full_name from players where team_id = %s",
        (team_id,),
    )
    rows = cur.fetchall()
    # An exact full-name match ("Gabriel" == the real player named just
    # "Gabriel") wins outright even if the surname substring is otherwise
    # ambiguous against teammates like Gabriel Martinelli/Gabriel Jesus.
    raw_clean = re.sub(r"[^a-z]", "", strip_accents(raw_name).lower())
    for pid, full_name in rows:
        if re.sub(r"[^a-z]", "", strip_accents(full_name).lower()) == raw_clean:
            return pid
    candidates = []
    for pid, full_name in rows:
        full_key = re.sub(r"[^a-z]", "", strip_accents(full_name).lower())
        if full_key.endswith(key) or key in full_key:
            candidates.append((pid, full_name))
    if len(candidates) == 1:
        return candidates[0][0]
    return None  # ambiguous or no match - leave unresolved rather than guess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-date", default=None, help="YYYY-MM-DD, defaults to today")
    args = parser.parse_args()
    snapshot_date = datetime.strptime(args.snapshot_date, "%Y-%m-%d").date() if args.snapshot_date else date.today()

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()

    cur.execute("select id, name from teams")
    team_id_by_name = {name: tid for tid, name in cur.fetchall()}

    inserted, matched, unmatched = 0, 0, 0
    unmatched_rows = []

    for team_name, formation, slots in DATA:
        team_id = team_id_by_name.get(team_name)
        if not team_id:
            print(f"  [skip] unknown team: {team_name}")
            continue
        for position_slot, candidates in slots:
            for rank, (raw_name, pct, is_new) in enumerate(candidates, start=1):
                player_id = match_player(cur, team_id, raw_name)
                if player_id:
                    matched += 1
                else:
                    unmatched += 1
                    unmatched_rows.append((team_name, position_slot, raw_name))
                cur.execute(
                    """
                    insert into player_lineup_probability
                        (team_id, formation, position_slot, slot_rank, player_id, raw_name,
                         start_probability, is_new_signing, snapshot_date, source)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    on conflict (team_id, position_slot, slot_rank, snapshot_date, source) do update
                        set player_id = excluded.player_id, raw_name = excluded.raw_name,
                            start_probability = excluded.start_probability, is_new_signing = excluded.is_new_signing,
                            formation = excluded.formation
                    """,
                    (team_id, formation, position_slot, rank, player_id, raw_name, pct, is_new, snapshot_date, SOURCE),
                )
                inserted += 1

    conn.commit()
    print(f"\nWrote {inserted} rows for {snapshot_date} ({matched} matched to a real player_id, {unmatched} unmatched).")
    if unmatched_rows:
        print("\nUnmatched (left as player_id = NULL, raw_name preserved):")
        for team_name, slot, raw_name in unmatched_rows:
            print(f"  [{team_name} {slot}] {raw_name!r}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
